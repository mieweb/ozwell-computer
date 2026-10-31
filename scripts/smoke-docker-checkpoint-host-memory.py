#!/usr/bin/env python3
"""Owned-daemon-only Mac RSS observation; no cache flushing or host changes."""
import subprocess, json, time, secrets, statistics, pathlib, sys

if sys.platform != 'darwin' or len(sys.argv) != 3:
 raise SystemExit('Usage on Mac: smoke-docker-checkpoint-host-memory.py <owned lab container> <results.json>')
lab=sys.argv[1]
if not lab.startswith('ozc-mac-checkpoint-'):
 raise SystemExit('Refusing a container outside the owned checkpoint lab namespace')
out=pathlib.Path(sys.argv[2])
suffix=secrets.token_hex(5)
main='ozc-mac-checkpoint-memory-'+suffix
anchor=main+'-net'
guarded=False
result={'passed':False,'payload_bytes':1024**3,'samples':{},'limitations':[
 'OrbStack Helper RSS is shared with unrelated containers and Linux filesystem caches.',
 'No host cache flush, memory pressure, engine restart or global setting change is used.',
 'This measures observed host RSS; it does not promise zero RAM for the shared VM.']}
def cmd(args,check=True):
 p=subprocess.run(args,text=True,capture_output=True)
 if check and p.returncode:raise RuntimeError(p.stderr[-2000:])
 return p.stdout.strip()
def inner(*args):return cmd(['docker','exec',lab,'docker',*args])
def status():
 code="const r=await fetch(process.argv[1],{headers:{connection:'close'}});if(!r.ok)throw Error(r.status);console.log(await r.text())"
 return json.loads(cmd(['docker','exec',lab,'node','--input-type=module','-e',code,'http://'+ip+':8088/']))
def sample(stage,seconds):
 rows=[]
 for _ in range(seconds):
  rss=int(cmd(['ps','-p',str(helper),'-o','rss=']))*1024
  rows.append({'time':time.time(),'rss_bytes':rss});time.sleep(1)
 result['samples'][stage]=rows
 result.setdefault('medians',{})[stage]=statistics.median([r['rss_bytes'] for r in rows[-10:]])
 out.write_text(json.dumps(result,indent=2)+'\n')
 print(stage,round(result['medians'][stage]/1024**2,1),'MiB',flush=True)
try:
 info=json.loads(inner('info','--format','{{json .}}'))
 marker=json.loads(cmd(['docker','exec',lab,'cat','/lab/.ozwell-checkpoint-lab']))
 assert info['ID']==marker['daemonId']
 assert inner('ps','-q')=='','Probe requires no running workload in its owned daemon'
 guarded=True
 helpers=[]
 for line in cmd(['ps','-axo','pid,rss,comm']).splitlines():
  parts=line.split(None,2)
  if len(parts)==3 and parts[2].endswith('/Contents/MacOS/OrbStack Helper'):helpers.append((int(parts[1]),int(parts[0])))
 assert len(helpers)==1
 helper=helpers[0][1]
 result.update({'helper_pid':helper,'daemon_id':info['ID'],'kernel':info['KernelVersion'],'architecture':info['Architecture'],'started_at':time.time()})
 sample('baseline',15)
 inner('run','-d','--name',anchor,'--entrypoint','/bin/sleep','--read-only','--cap-drop','ALL','alpine:3.19','infinity')
 ip=inner('inspect',anchor,'--format','{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
 code="""const {randomBytes,createHash}=require('node:crypto');const http=require('node:http');const payload=randomBytes(1024**3);const nonce=randomBytes(32).toString('hex');let counter=0;setInterval(()=>counter++,100);http.createServer((req,res)=>{res.setHeader('connection','close');res.end(JSON.stringify({pid:process.pid,nonce,counter,bytes:payload.length,sha256:createHash('sha256').update(payload).digest('hex')}))}).listen(8088,'0.0.0.0');"""
 inner('run','-d','--name',main,'--network','container:'+anchor,'--annotation','org.criu.config=/opt/ozc-criu/ozwell.conf','node:24-bookworm-slim','node','-e',code)
 deadline=time.time()+60
 while True:
  try:before=status();break
  except Exception:
   if time.time()>deadline:raise
   time.sleep(1)
 result['before']=before
 sample('active',20)
 started=time.monotonic();inner('checkpoint','create',main,'memory-proof');result['save_ms']=round((time.monotonic()-started)*1000)
 state=json.loads(inner('inspect',main,'--format','{{json .State}}'))
 stats=json.loads(inner('stats','--all','--no-stream','--format','{{json .}}',main))
 assert not state['Running'] and state['Pid']==0 and stats['PIDs']=='0'
 result['saved_state']=state;result['saved_stats']=stats
 sample('saved',35)
 started=time.monotonic();inner('start','--checkpoint','memory-proof',main);result['restore_ms']=round((time.monotonic()-started)*1000)
 deadline=time.time()+60
 while True:
  try:after=status();break
  except Exception:
   if time.time()>deadline:raise
   time.sleep(1)
 assert all(before[k]==after[k] for k in ['pid','nonce','bytes','sha256']) and after['counter']>before['counter']
 result['after']=after
 sample('restored',15)
 result['host_rss_release_bytes']=result['medians']['active']-result['medians']['saved']
 result['passed']=True
except Exception as error:
 result['error']=str(error);raise
finally:
 if guarded:
  for name in [main,anchor]:inner('rm','-f','-v',name) if cmd(['docker','exec',lab,'docker','inspect',name],check=False) else None
 result['finished_at']=time.time();out.write_text(json.dumps(result,indent=2)+'\n')
 print(str(out),flush=True)
