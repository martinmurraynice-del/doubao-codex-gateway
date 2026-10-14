#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {ROOT, STATE_DIR, CONFIG_FILE, loadConfig, validateConfig, GatewayError} from './config.mjs';
import {GatewayClient} from './client.mjs';

const DEFAULT_SERVICE_LABEL='io.github.doubao-codex-gateway';
const INSTALLATION_FILE=path.join(path.dirname(STATE_DIR),'installation.json');
const argv=process.argv.slice(2);
const command=argv.shift()||'help';
const print=value=>console.log(JSON.stringify(value,null,2));
function installation() {
  if(!fs.existsSync(INSTALLATION_FILE))return null;
  let record;
  try {record=JSON.parse(fs.readFileSync(INSTALLATION_FILE,'utf8'));}
  catch {throw new GatewayError('INSTALLATION','Installation metadata cannot be read or is not valid JSON.');}
  if(!record||typeof record!=='object'||Array.isArray(record)
    ||typeof record.runtime!=='string'||!path.isAbsolute(record.runtime)||record.runtime.includes('\0')
    ||(record.source!==undefined&&(typeof record.source!=='string'||!path.isAbsolute(record.source)||record.source.includes('\0')))
    ||(record.serviceLabel!==undefined&&(typeof record.serviceLabel!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(record.serviceLabel)))
    ||(record.nodeBin!==undefined&&(typeof record.nodeBin!=='string'||!path.isAbsolute(record.nodeBin)||record.nodeBin.includes('\0')))) {
    throw new GatewayError('INSTALLATION','Installation metadata contains an invalid runtime, service label, or Node path.');
  }
  return record;
}
function servicePaths(record=installation()) {
  const label=record?.serviceLabel||DEFAULT_SERVICE_LABEL;
  return {label,service:`gui/${os.userInfo().uid}/${label}`,plist:path.join(os.homedir(),'Library','LaunchAgents',`${label}.plist`)};
}
function initOptions() {
  try {
    const parsed=parseArgs({args:argv,allowPositionals:false,tokens:true,options:{
      'allow-root':{type:'string',multiple:true},'codex-bin':{type:'string'},port:{type:'string'},model:{type:'string'},
    }});
    const seen=new Set();
    for(const token of parsed.tokens) {
      if(token.kind!=='option'||token.name==='allow-root')continue;
      if(seen.has(token.name))throw new Error(`Specify --${token.name} only once.`);
      seen.add(token.name);
    }
    if(parsed.values.port!==undefined&&!/^\d+$/.test(parsed.values.port))throw new Error('--port must be an integer.');
    return parsed.values;
  } catch(error) {throw new GatewayError('INPUT',error.message);}
}
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
function registered(service) {try {execFileSync('launchctl',['print',service],{stdio:'ignore'});return true;}catch{return false;}}
function privateState() {
  const target=fs.existsSync(STATE_DIR)?fs.realpathSync(STATE_DIR):STATE_DIR;
  if(target===path.parse(target).root||target===fs.realpathSync(os.homedir())) {
    throw new GatewayError('INPUT','GATEWAY_STATE_DIR must be a dedicated directory, not the filesystem root or your home.');
  }
  fs.mkdirSync(STATE_DIR,{recursive:true,mode:0o700});fs.chmodSync(STATE_DIR,0o700);
}
async function main() {
  const commands=new Set(['help','--help','-h','init','serve','call','status','doctor','connector-config','paths','install','uninstall']);
  if(!commands.has(command))throw new GatewayError('INPUT',`Unknown command: ${command}. Run help for usage.`);
  if(!['init','call'].includes(command)&&argv.length)throw new GatewayError('INPUT',`${command} does not accept additional arguments.`);
  if(command==='init') {
    const options=initOptions();
    const file=CONFIG_FILE;
    if(fs.existsSync(file))throw new GatewayError('CONFIG_EXISTS',`Configuration already exists; edit deliberately: ${file}`);
    let config;
    try {config=validateConfig({port:Number(options.port??18593),codexBin:options['codex-bin']??'codex',allowedRoots:options['allow-root'],maxConcurrent:1,model:options.model??null});}
    catch(error) {throw new GatewayError('INPUT',error.message);}
    privateState();fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,JSON.stringify(config,null,2)+'\n',{mode:0o600,flag:'wx'});
    print({configured:true,file,allowedRoots:config.allowedRoots,model:config.model});return;
  }
  if(command==='serve') {
    const {startServer}=await import('./server.mjs');
    const running=await startServer({config:loadConfig(),stateDir:STATE_DIR});
    console.error(`Doubao Codex Gateway listening at ${running.url}`);
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;await running.close();process.exit(0);};
    process.on('SIGTERM',stop);process.on('SIGINT',stop);return;
  }
  if(command==='call') {
    const [method,json='{}']=argv;if(!method||argv.length>2)throw new GatewayError('INPUT','Usage: call METHOD JSON');
    print(await new GatewayClient().call(method,JSON.parse(json)));return;
  }
  if(command==='status') {print(await new GatewayClient().call('health'));return;}
  if(command==='doctor') {
    const checks={node:process.version,nodeSupported:Number(process.versions.node.split('.')[0])>=24};
    try {
      const config=loadConfig();checks.configuration='ok';checks.allowedRoots=config.allowedRoots;
      checks.codexVersion=execFileSync(config.codexBin,['--version'],{encoding:'utf8',timeout:10000}).trim();
      checks.codexLogin=execFileSync(config.codexBin,['login','status'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim()||'Authenticated';
    } catch(error) {checks.configurationError=error.message;}
    try {checks.gateway=await new GatewayClient().call('health',{}, {timeoutMs:5000});}catch(error){checks.gatewayError=error.message;}
    checks.launchAgent=process.platform==='darwin'&&registered(servicePaths().service);print(checks);
    if(checks.configurationError||checks.gatewayError||!checks.nodeSupported)process.exitCode=1;
    return;
  }
  if(command==='connector-config') {
    const record=installation();
    const runtime=record?.runtime||ROOT;
    const installedSkill=path.join(runtime,'skills','doubao-codex-executor','SKILL.md');
    const source=typeof record?.source==='string'&&path.isAbsolute(record.source)?record.source:ROOT;
    const skill=fs.existsSync(installedSkill)?installedSkill:path.join(source,'skills','doubao-codex-executor','SKILL.md');
    print({name:'Doubao Codex Gateway',transport:'STDIO',command:record?.nodeBin||process.execPath,args:[path.join(runtime,'src','mcp.mjs')],env:{GATEWAY_STATE_DIR:STATE_DIR},skill});return;
  }
  if(command==='paths') {
    const record=installation();
    const paths=servicePaths(record);
    print({source:ROOT,stateDir:STATE_DIR,configFile:CONFIG_FILE,installationFile:INSTALLATION_FILE,runtime:record?.runtime||ROOT,nodeBin:record?.nodeBin||process.execPath,serviceLabel:paths.label,launchAgentPlist:process.platform==='darwin'?paths.plist:null});return;
  }
  if(command==='install') {
    if(process.platform!=='darwin')throw new GatewayError('PLATFORM','LaunchAgent installation is macOS-only. Run serve under your service manager.');
    const {label,service,plist}=servicePaths();
    loadConfig();
    if(registered(service)){const health=await new GatewayClient().call('health',{}, {timeoutMs:5000});print({installed:true,alreadyRunning:true,service,health});return;}
    try {await new GatewayClient().call('health',{}, {timeoutMs:1000});throw new GatewayError('ALREADY_RUNNING','Stop the foreground gateway before installing its LaunchAgent.');}
    catch(error){if(error.code==='ALREADY_RUNNING')throw error;}
    privateState();fs.mkdirSync(path.dirname(plist),{recursive:true});
    if(fs.existsSync(plist))throw new GatewayError('PLIST_EXISTS',`An existing service file was not overwritten: ${plist}. Inspect or uninstall it first.`);
    // Install our own runtime in Application Support: launchd must not need a
    // Desktop working directory or Desktop log files simply to start Node.
    const runtime=path.join(path.dirname(STATE_DIR),'deployments',`${Date.now()}`);
    fs.mkdirSync(runtime,{recursive:true,mode:0o700});
    for(const name of ['src','skills','node_modules','package.json','package-lock.json'])fs.cpSync(path.join(ROOT,name),path.join(runtime,name),{recursive:true,errorOnExist:true,force:false});
    fs.writeFileSync(INSTALLATION_FILE,JSON.stringify({runtime,source:ROOT,nodeBin:process.execPath,serviceLabel:label,installedAt:new Date().toISOString()},null,2),{mode:0o600});
    for(const file of ['service.log','service.error.log'])fs.closeSync(fs.openSync(path.join(STATE_DIR,file),'a',0o600));
    const env={PATH:process.env.PATH||'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',GATEWAY_STATE_DIR:STATE_DIR,GATEWAY_CONFIG:CONFIG_FILE};
    const document=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(runtime,'src','cli.mjs'))}</string><string>serve</string></array><key>WorkingDirectory</key><string>${xml(runtime)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([key,value])=>`<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(STATE_DIR,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(STATE_DIR,'service.error.log'))}</string></dict></plist>\n`;
    fs.writeFileSync(plist,document,{mode:0o600,flag:'wx'});
    execFileSync('launchctl',['bootstrap',`gui/${os.userInfo().uid}`,plist],{stdio:'inherit'});
    for(let attempt=0;attempt<40;attempt++) {
      try {const health=await new GatewayClient().call('health',{}, {timeoutMs:1000});print({installed:true,service,plist,health});return;}catch{}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new GatewayError('STARTUP',`Service was registered but is not healthy yet. Inspect ${path.join(STATE_DIR,'service.error.log')}.`);
  }
  if(command==='uninstall') {
    if(process.platform!=='darwin')throw new GatewayError('PLATFORM','LaunchAgent is macOS-only.');
    const {service,plist}=servicePaths();
    try {const runs=await new GatewayClient().call('list',{limit:100});if(runs.some(run=>run.holdsCapacity||run.status==='queued'))throw new GatewayError('BUSY','Finish or cancel active/queued runs before uninstalling.');}
    catch(error){if(error.code==='BUSY')throw error;}
    if(registered(service))execFileSync('launchctl',['bootout',service],{stdio:'inherit'});
    if(fs.existsSync(plist))fs.renameSync(plist,`${plist}.disabled-${Date.now()}`);
    print({uninstalled:true,note:'Service registration removed; task database, artifacts, configuration and a disabled plist backup are retained.'});return;
  }
  console.log('Doubao Codex Gateway\n  init --allow-root ABS [--codex-bin ABS] [--port 18593] [--model CATALOG_ID]\n  serve | install | uninstall | doctor | status | connector-config | paths\n  call METHOD \'{"parameter":"value"}\'');
}
main().catch(error=>{console.error(JSON.stringify({error:{code:error.code||'ERROR',message:error.message}}));process.exitCode=1;});
