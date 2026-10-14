import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { GatewayError, inside, workspaceFor } from './config.mjs';

const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled']);
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const REPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked'] },
    text: { type: 'string' },
    artifacts: { type: 'array', items: { type: 'string' } },
    data: { type: ['string', 'null'], description: 'JSON-encoded structured result when requested, otherwise null.' },
  },
  required: ['status', 'text', 'artifacts', 'data'],
};
function text(value, name, max = 60000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new GatewayError('INVALID_INPUT', `${name} must be nonempty text of at most ${max} characters.`);
  return value.trim();
}
export function verifiedArtifact(workspace, value) {
  const file = path.resolve(workspace, text(value, 'artifact path', 4000));
  if (!inside(workspace, file)) throw new GatewayError('ARTIFACT_DENIED', 'Artifact path escapes the workspace.');
  const real = fs.realpathSync(file);
  if (!inside(workspace, real)) throw new GatewayError('ARTIFACT_DENIED', 'Artifact symlink escapes the workspace.');
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new GatewayError('ARTIFACT_DENIED', 'Artifact is not a regular file.');
  return {path: real, name: path.relative(workspace, real), bytes: stat.size};
}

export class Engine {
  constructor({store, client, config}) {
    this.store = store; this.client = client; this.config = config;
    this.pumping = false; this.closing = false; this.bindingLocks = new Map();
    // Codex does not persist a rollout until the first turn. A just-created
    // thread is already loaded in this app-server and cannot yet be resumed.
    this.freshThreads = new Map();
    client.on('notification', message => {
      try { this.notification(message); } catch (error) { console.error('Event handling failed:', error.message); }
    });
    client.on('disconnect', () => {
      this.freshThreads.clear();
      if (this.closing) return;
      for (const run of store.all().filter(run => run.holdsCapacity)) {
        store.save({...run,status:'uncertain',error:{code:'DISCONNECTED',message:'Codex disconnected. Inspect and recover this task; it has not been resubmitted.'}});
      }
    });
    client.on('serverRequest', request => this.serverRequest(request));
  }
  get(id) { const run = this.store.get(id); return {...run,cursor:this.store.cursor(id)}; }
  list(limit = 20) { return this.store.all().reverse().slice(0,Math.max(1,Math.min(100,Number(limit)||20))).map(run => ({id:run.id,workspace:run.workspace,task:run.task.slice(0,300),status:run.status,review:run.review,attempt:run.attempt,threadId:run.threadId,turnId:run.turnId,holdsCapacity:run.holdsCapacity,updatedAt:run.updatedAt})); }
  async models() {
    const models=[]; let cursor;
    do { const page=await this.client.request('model/list',{limit:100,...(cursor?{cursor}:{})}); models.push(...page.data); cursor=page.nextCursor; } while(cursor && models.length<1000);
    return {models:models.map(item => ({id:item.model || item.id,displayName:item.displayName,description:item.description,reasoningEfforts:item.supportedReasoningEfforts,isDefault:item.isDefault})),note:'A model catalog is not an account entitlement or quota check.'};
  }
  async bindWorkspace(input) {
    const workspace=workspaceFor(this.config,input.workspace);
    if (this.bindingLocks.has(workspace)) return this.bindingLocks.get(workspace);
    const operation=this._bind(workspace,input);
    this.bindingLocks.set(workspace,operation);
    try { return await operation; } finally { this.bindingLocks.delete(workspace); }
  }
  async _bind(workspace,{threadId,model}) {
    const previous=this.store.binding(workspace);
    if (previous?.status==='ready' && (!threadId||threadId===previous.threadId) && (!model||model===previous.model)) return previous;
    if (this.store.all().some(run=>run.workspace===workspace && (run.holdsCapacity||run.status==='queued'))) throw new GatewayError('WORKSPACE_BUSY','Finish or cancel pending tasks before rebinding.');
    if (['uncertain','creating'].includes(previous?.status) && !threadId) throw new GatewayError('BINDING_UNCERTAIN','Thread creation outcome is uncertain; explicitly bind a verified thread id.');
    const targetThreadId=threadId||previous?.threadId||null;
    const targetModel=model||previous?.model||this.config.model||null;
    this.store.bind({workspace,threadId:targetThreadId,status:'creating',model:targetModel,updatedAt:now()});
    try {
      let response;
      if (targetThreadId) {
        const fresh=this.freshThreads.get(targetThreadId);
        const original=fresh?{thread:fresh.thread}:await this.client.request('thread/read',{threadId:targetThreadId,includeTurns:true});
        if (fs.realpathSync(original.thread.cwd)!==workspace) throw new GatewayError('THREAD_WORKSPACE_MISMATCH','Thread belongs to another workspace.');
        if (original.thread.turns?.some(turn=>turn.status==='inProgress')) throw new GatewayError('THREAD_BUSY','Thread has an active turn.');
        response=fresh?original:await this.client.request('thread/resume',{threadId:targetThreadId,cwd:workspace,approvalPolicy:'never',sandbox:'workspace-write',...(targetModel?{model:targetModel}:{})});
      } else {
        response=await this.client.request('thread/start',{cwd:workspace,model:targetModel,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:false});
        this.freshThreads.set(response.thread.id,{workspace,thread:response.thread});
      }
      return this.store.bind({workspace,threadId:response.thread.id,status:'ready',model:targetModel||response.model||null,updatedAt:now()});
    } catch(error) {
      if (previous?.status==='ready') this.store.bind(previous);
      else this.store.bind({workspace,threadId:targetThreadId,status:'uncertain',error:error.message,updatedAt:now()});
      throw error;
    }
  }
  async submit(input) {
    const workspace=workspaceFor(this.config,input.workspace);
    const task=text(input.task,'task');
    const key=text(input.idempotencyKey,'idempotencyKey',200);
    const constraints=input.constraints||[];
    if (!Array.isArray(constraints)||constraints.length>40||constraints.some(value=>typeof value!=='string'||value.length>4000)) throw new GatewayError('INVALID_INPUT','Invalid constraints.');
    const output=input.output||'text';
    if (!['text','json','artifacts'].includes(output)) throw new GatewayError('INVALID_INPUT','Invalid output format.');
    const timeoutSeconds=input.timeoutSeconds??1800;
    if (!Number.isInteger(timeoutSeconds)||timeoutSeconds<10||timeoutSeconds>86400) throw new GatewayError('INVALID_INPUT','timeoutSeconds must be 10–86400.');
    if(input.effort&&!['low','medium','high','xhigh'].includes(input.effort)) throw new GatewayError('INVALID_INPUT','Invalid effort.');
    if(input.model)text(input.model,'model',200);
    const normalized={workspace,task,constraints,output,timeoutSeconds,model:input.model||null,effort:input.effort||null};
    const fingerprint=hash(normalized);
    const previous=this.store.byKey(`submit:${key}`,fingerprint);
    if (previous) return this.get(previous.id);
    const binding=await this.bindWorkspace({workspace});
    const run={id:`dcg-${crypto.randomUUID()}`,...normalized,status:'queued',review:'pending',holdsCapacity:false,attempt:1,threadId:binding.threadId,turnId:null,result:null,error:null,history:[],createdAt:now(),updatedAt:now(),deadline:new Date(Date.now()+timeoutSeconds*1000).toISOString(),runtimeSource:'codex_app_server',usage:null};
    const persisted=this.store.create(run,`submit:${key}`,fingerprint);
    return this.get(persisted.id);
  }
  prompt(run) {
    return `Execute this authorized task in the current workspace. Use your own tools to perform and verify it.\nGateway task ${run.id}, attempt ${run.attempt}.\nWorkspace: ${run.workspace}\nObjective: ${run.task}\nConstraints:\n${run.constraints.map(value=>`- ${value}`).join('\n')}\n${run.feedback?`Rework feedback (preserve existing useful work): ${run.feedback}\n`:''}Stay within the workspace and requested scope. If a permission, login or missing input prevents progress, report it honestly; do not change gateway configuration. Do not delegate back to this gateway.\nFinal response must be one JSON object, without markdown fences: {"status":"completed" or "blocked","text":"concise result and verification evidence","artifacts":["relative paths of actual deliverable files"],"data":null}. For output=json, data must be a STRING containing the JSON-encoded requested result; the gateway will parse it into structured data. Otherwise data is null. Include only actual files inside this workspace. Requested output: ${run.output}. A report of completion is subject to independent review.`;
  }
  async replaceUnstartedThread(run) {
    const binding=this.store.binding(run.workspace);
    const related=this.store.all().filter(item=>item.threadId===run.threadId);
    const hasIntent=related.some(item=>item.dispatchStartedAt||item.turnId||item.history?.some(attempt=>attempt.turnId||attempt.dispatchStartedAt));
    if(hasIntent||binding?.status!=='ready'||binding.threadId!==run.threadId) {
      throw new GatewayError('EMPTY_THREAD_NOT_PERSISTED','The thread has no rollout and prior dispatch cannot be ruled out. No work was resubmitted; inspect the original session.');
    }
    // The exact no-rollout error plus an absence of durable dispatch intent is
    // the only circumstance in which an empty thread may be recreated.
    const previousId=run.threadId;
    this.store.bind({...binding,status:'creating',threadId:null,replacesThreadId:previousId,updatedAt:now()});
    let response;
    try {
      response=await this.client.request('thread/start',{cwd:run.workspace,model:binding.model||this.config.model||null,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:false});
      this.freshThreads.set(response.thread.id,{workspace:run.workspace,thread:response.thread});
      for(const item of related)this.store.save({...item,threadId:response.thread.id},'thread_rebound',{previousThreadId:previousId,threadId:response.thread.id,reason:'Empty thread had no persisted dispatch intent.'});
      this.store.bind({...binding,status:'ready',threadId:response.thread.id,replacesThreadId:previousId,updatedAt:now()});
      return {run:this.store.get(run.id),response};
    } catch(error) {
      this.store.bind({...binding,status:'uncertain',threadId:response?.thread.id||null,replacesThreadId:previousId,error:error.message,updatedAt:now()});
      throw error;
    }
  }
  async dispatch(run) {
    try {
      workspaceFor(this.config,run.workspace);
      const binding=this.store.binding(run.workspace);
      if(binding?.status!=='ready'||binding.threadId!==run.threadId)throw new GatewayError('BINDING_UNCERTAIN','Workspace binding must be verified before dispatch.');
      const fresh=this.freshThreads.get(run.threadId);
      let resumed;
      if(fresh?.workspace===run.workspace) {
        // Read live state when available, but an empty owned thread may have
        // no readable rollout yet. Only this exact error permits its snapshot.
        try { resumed=await this.client.request('thread/read',{threadId:run.threadId,includeTurns:true}); }
        catch(error) {
          if(error.code!==-32600||!/no rollout found for thread id/i.test(error.message))throw error;
          resumed={thread:fresh.thread};
        }
      }
      else {
        try { resumed=await this.client.request('thread/resume',{threadId:run.threadId,cwd:run.workspace,approvalPolicy:'never',sandbox:'workspace-write'}); }
        catch(error) {
          if(error.code!==-32600||!/no rollout found for thread id/i.test(error.message))throw error;
          const replacement=await this.replaceUnstartedThread(run);
          run=replacement.run;resumed=replacement.response;
        }
      }
      const active=resumed.thread.turns?.find(turn=>turn.status==='inProgress');
      if (active) {
        this.store.save({...run,status:'blocked',holdsCapacity:true,blockingTurnId:active.id,error:{code:'THREAD_BUSY',message:'The Codex thread has an external running turn. This task was not submitted; recover after that turn ends.'}});
        return;
      }
      run={...run,priorTurnIds:(resumed.thread.turns||[]).map(turn=>turn.id)};
    } catch(error) {
      this.store.save({...run,status:'blocked',holdsCapacity:false,error:{code:error.code||'RESUME_FAILED',message:error.message}}); return;
    }
    // The intent is durable before turn/start. A lost reply must never cause replay.
    run=this.store.save({...run,status:'dispatching',holdsCapacity:true,dispatchStartedAt:now()});
    this.freshThreads.delete(run.threadId);
    try {
      const model=run.model||this.store.binding(run.workspace)?.model;
      const response=await this.client.request('turn/start',{threadId:run.threadId,input:[{type:'text',text:this.prompt(run),text_elements:[]}],outputSchema:REPORT_SCHEMA,...(model?{model}:{}),...(run.effort?{effort:run.effort}:{})});
      const current=this.store.get(run.id);
      if(current.attempt!==run.attempt||terminal.has(current.status))return;
      this.store.save({...current,turnId:response.turn.id,status:current.status==='cancel_requested'?'cancel_requested':'running'});
      if(current.status==='cancel_requested')await this.client.request('turn/interrupt',{threadId:run.threadId,turnId:response.turn.id});
    } catch(error) {
      const current=this.store.get(run.id);
      if(terminal.has(current.status))return;
      this.store.save({...current,status:error.sent===false?'failed':'uncertain',holdsCapacity:error.sent!==false,error:{code:error.code||'DISPATCH_UNCERTAIN',message:error.message}});
    }
  }
  async tick() {
    if (this.pumping||this.closing) return;
    this.pumping=true;
    try {
      for(const run of this.store.all()) {
        if(Date.parse(run.deadline)>Date.now())continue;
        if(run.status==='queued')this.store.save({...run,status:'failed',error:{code:'DEADLINE','message':'Task expired while queued; nothing was executed.'}});
        else if(run.holdsCapacity && !run.blockingTurnId && !['cancel_requested','uncertain'].includes(run.status))await this.cancel(run.id,'Task deadline reached.');
      }
      for(const run of this.store.all().filter(run=>run.status==='queued')) {
        const occupied=this.store.all().filter(run=>run.holdsCapacity);
        if(occupied.length>=this.config.maxConcurrent)break;
        if(occupied.some(active=>active.workspace===run.workspace||active.threadId===run.threadId))continue;
        await this.dispatch(run);
      }
    } finally { this.pumping=false; }
  }
  notification({method,params={}}) {
    const run=this.store.all().find(run=>run.holdsCapacity && run.threadId===params.threadId);
    if(!run)return;
    // An external turn is not this task. Only explicit recovery can clear its
    // workspace reservation after checking that exact turn's persisted state.
    if(run.blockingTurnId)return;
    const eventTurn=params.turnId||params.turn?.id;
    if(eventTurn && (run.priorTurnIds?.includes(eventTurn)||run.history.some(item=>item.turnId===eventTurn)))return;
    if(run.turnId && eventTurn && run.turnId!==eventTurn)return;
    if(method==='turn/started') {
      if(!run.turnId && run.history.some(item=>item.turnId===eventTurn))return;
      this.store.save({...run,turnId:params.turn.id,status:run.status==='cancel_requested'?'cancel_requested':'running'});
    } else if(method==='item/completed') {
      const item=params.item;
      if(item?.type==='agentMessage') {
        this.store.save({...run,lastMessage:item.text,lastPhase:item.phase},'message',{text:item.text?.slice(0,12000),phase:item.phase,truncated:item.text?.length>12000});
      } else if(item) {
        this.store.event(run.id,'item',{type:item.type,id:item.id,status:item.status,exitCode:item.exitCode,command:item.type==='commandExecution'?item.command?.slice(0,1000):undefined});
      }
    } else if(method==='turn/completed') this.finish(run,params.turn);
    else if(method==='error') this.store.event(run.id,'error',{message:params.error?.message||params.message||'Codex error',willRetry:params.willRetry});
    else if(method==='thread/tokenUsage/updated') this.store.save({...run,usage:params.tokenUsage},'usage',params.tokenUsage);
  }
  finish(run,turn) {
    if(run.turnId&&run.turnId!==turn.id)return;
    const updated={...run,turnId:turn.id,holdsCapacity:false,finishedAt:now()};
    if(turn.status==='interrupted') { this.store.save({...updated,status:'cancelled',error:{code:'INTERRUPTED',message:'Codex confirmed interruption. Existing file changes are retained.'}}); return; }
    if(turn.status!=='completed') { this.store.save({...updated,status:'failed',error:{code:'CODEX_FAILED',message:turn.error?.message||`Turn ended with ${turn.status}`}});return; }
    try {
      const messages=(turn.items||[]).filter(item=>item.type==='agentMessage');
      const final=messages.findLast(item=>item.phase==='final_answer')||messages.at(-1);
      const raw=final?.text||run.lastMessage||'';
      if(raw.length>1000000)throw new Error('Final report exceeds 1 MB.');
      const report=JSON.parse(raw.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
      if(!['completed','blocked'].includes(report.status)||typeof report.text!=='string'||!Array.isArray(report.artifacts)||report.artifacts.length>100)throw new Error('Expected a status/text/artifacts report.');
      const artifacts=report.artifacts.map(file=>verifiedArtifact(run.workspace,file));
      if(report.status==='completed'&&run.output==='json'&&(report.data===undefined||report.data===null))throw new Error('Requested JSON data is missing.');
      const data=run.output==='json'&&typeof report.data==='string'?JSON.parse(report.data):report.data??null;
      if(report.status==='completed'&&run.output==='artifacts'&&!artifacts.length)throw new Error('No deliverable files were supplied.');
      this.store.save({...updated,status:report.status,review:'pending',result:{text:report.text,data,artifacts},error:report.status==='blocked'?{code:'NEEDS_INPUT',message:report.text}:null});
    } catch(error) {
      this.store.save({...updated,status:'failed',error:{code:'INVALID_OUTPUT',message:error.message},rawReport:(run.lastMessage||'').slice(0,12000)});
    }
  }
  serverRequest({id,method,params={}}) {
    const run=this.store.all().find(run=>run.threadId===params.threadId&&run.holdsCapacity);
    if(run)this.store.event(run.id,'permission',{method,decision:'declined',reason:'Additional permissions require direct user handling; gateway does not auto-approve.'});
    if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval')this.client.respond(id,{decision:'decline'});
    else if(method==='item/permissions/requestApproval')this.client.respond(id,{permissions:{},scope:'turn'});
    else if(method==='item/tool/requestUserInput')this.client.respond(id,{answers:{}});
    else this.client.reject(id,'This gateway cannot handle this request; report the blocker in the final result.');
  }
  async cancel(id,reason='User requested cancellation.') {
    let run=this.store.get(id);
    if(!run.holdsCapacity&&terminal.has(run.status))return this.get(id);
    if(run.status==='queued')return this.store.save({...run,status:'cancelled',holdsCapacity:false,error:{code:'CANCELLED',message:reason}});
    if(run.blockingTurnId)return this.store.save({...run,status:'blocked',error:{code:'THREAD_BUSY',message:'This task was never submitted. Its external blocking turn cannot be cancelled through this task; recover after it finishes.'}});
    run=this.store.save({...run,status:'cancel_requested',error:{code:'CANCEL_REQUESTED',message:reason}});
    if(run.turnId) {
      try { await this.client.request('turn/interrupt',{threadId:run.threadId,turnId:run.turnId}); }
      catch(error) { this.store.event(id,'interrupt_error',{message:error.message}); }
    }
    return this.get(id);
  }
  rework({id,feedback,idempotencyKey}) {
    feedback=text(feedback,'feedback'); const key=text(idempotencyKey,'idempotencyKey',200);
    const fingerprint=hash({id,feedback});const previous=this.store.byKey(`rework:${key}`,fingerprint);if(previous)return this.get(previous.id);
    const run=this.store.get(id);
    if(run.holdsCapacity||!terminal.has(run.status))throw new GatewayError('RUN_ACTIVE','Confirm the previous turn ended before rework.');
    const next={...run,status:'queued',review:'pending',attempt:run.attempt+1,turnId:null,blockingTurnId:null,lastMessage:null,result:null,error:null,finishedAt:null,feedback,history:[...run.history,{attempt:run.attempt,turnId:run.turnId,status:run.status,result:run.result,review:run.review,evidence:run.evidence,error:run.error}],evidence:null,deadline:new Date(Date.now()+run.timeoutSeconds*1000).toISOString(),updatedAt:now()};
    return this.store.rework(next,`rework:${key}`,fingerprint);
  }
  accept({id,evidence,artifactPaths=[]}) {
    const run=this.store.get(id);evidence=text(evidence,'evidence',12000);
    if(run.status!=='completed'||run.holdsCapacity)throw new GatewayError('NOT_REVIEWABLE','Only a finished valid result can be accepted.');
    if(!Array.isArray(artifactPaths)||artifactPaths.length>100)throw new GatewayError('INVALID_INPUT','Invalid artifact paths.');
    const checked=artifactPaths.map(file=>verifiedArtifact(run.workspace,file));
    return this.store.save({...run,review:'accepted',evidence,checkedArtifacts:checked,acceptedAt:now()},'accepted',{evidence,artifacts:checked});
  }
  async reconcile(run) {
    try {
      const response=await this.client.request('thread/read',{threadId:run.threadId,includeTurns:true});
      const turns=response.thread.turns||[];
      if(run.blockingTurnId) {
        const blocking=turns.find(turn=>turn.id===run.blockingTurnId);
        if(blocking&&['completed','failed','interrupted'].includes(blocking.status)) {
          this.store.save({...run,status:'blocked',holdsCapacity:false,blockingTurnId:null,error:{code:'EXTERNAL_TURN_ENDED',message:'The external turn ended. This task was never dispatched; use rework to authorize a new attempt.'}});
        } else {
          this.store.save({...run,status:'uncertain',holdsCapacity:true,error:{code:'EXTERNAL_TURN_UNCONFIRMED',message:'The exact external blocking turn is not confirmed finished. This task has not been submitted.'}});
        }
        return this.get(run.id);
      }
      const turn=run.turnId?turns.find(turn=>turn.id===run.turnId):null;
      if(!turn)throw new Error('Cannot identify the exact submitted turn; no task was resubmitted.');
      if(['completed','failed','interrupted'].includes(turn.status))this.finish(run,turn);
      else {
        await this.client.request('thread/resume',{threadId:run.threadId,cwd:run.workspace,approvalPolicy:'never',sandbox:'workspace-write'});
        this.store.save({...run,status:'uncertain',error:{code:'TURN_UNCONFIRMED',message:'Saved turn is not confirmed finished. Inspect the original Codex session before further work.'}});
      }
    } catch(error) {this.store.save({...run,status:'uncertain',holdsCapacity:true,error:{code:'RECOVERY_UNCERTAIN',message:error.message}});}
    return this.get(run.id);
  }
  async restore() { for(const run of this.store.all().filter(run=>run.holdsCapacity))await this.reconcile(run); }
  async recover({id,note}) {
    note=text(note,'note',4000);const run=this.store.get(id);
    if(!run.holdsCapacity)return this.get(id);
    this.store.event(id,'recovery_requested',{note});
    return this.reconcile(run);
  }
  async wait({id,after,timeoutSeconds=45}) {
    timeoutSeconds=Math.max(1,Math.min(50,Number(timeoutSeconds)||45));
    const cursor=after??this.store.cursor(id); const deadline=Date.now()+timeoutSeconds*1000;
    while(Date.now()<deadline) {
      const run=this.get(id);
      if(this.closing)return {run,events:this.store.events(id,cursor,100),timedOut:true,shuttingDown:true};
      if(terminal.has(run.status)||run.status==='uncertain'||run.cursor>cursor)return {run,events:this.store.events(id,cursor,100),timedOut:false};
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    return {run:this.get(id),events:this.store.events(id,cursor,100),timedOut:true};
  }
}
