// SPIKE ONLY (Task 13). Probe pages and a /log endpoint so the extension's timings are readable from a shell.
// Task 21 replaces this with the real demo server.
import http from 'node:http'
import fs from 'node:fs'

const PORT = Number(process.argv[2] || 3000)
const LOG = process.argv[3] || '/tmp/bsv-probe.log'

const page = (title, body, head = '') =>
  `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>${head}<body style="font:16px -apple-system;padding:16px">${body}`

const logger = `
function plog(tag, data){ try{ fetch('/log',{method:'POST',body:JSON.stringify({tag:tag,t:Date.now(),data:data||null}),keepalive:true}) }catch(e){} }
`
const routes = {
  '/probe': q => page('probe', `<h3>probe</h3><pre id=out>waiting</pre><iframe src="/frame${q.get('run')==='s5-frame'?'?handoff=1':''}" style="width:100%;height:80px"></iframe><script>${logger}
window.plog=plog
const q=new URLSearchParams(location.search)
const cmd=q.get('run')
const t0=performance.now()
window.addEventListener('message',e=>{ if(e.data&&e.data.source==='bsv-probe-reply'){ document.getElementById('out').textContent=JSON.stringify(e.data.reply).slice(0,500); plog('page-reply',{cmd:e.data.cmd,ms:Math.round(performance.now()-t0)}) } })
window.run=(c,extra)=>window.postMessage(Object.assign({source:'bsv-probe',cmd:c},extra||{}),'*')
if(cmd) setTimeout(()=>window.run(cmd, Object.fromEntries(q)),300)
for(const ev of ['visibilitychange','pageshow','pagehide','focus','blur','freeze','resume']){
  (ev==='visibilitychange'||ev==='freeze'||ev==='resume'?document:window).addEventListener(ev,()=>plog('s7-'+ev,{vis:document.visibilityState,focus:document.hasFocus()}))
}
let n=0; setInterval(()=>{ n++; plog('s7-tick',{n:n,vis:document.visibilityState}) },1000)
plog('page-load',{href:location.href,ua:navigator.userAgent})
</script>`),
  '/frame': () => page('frame', `<p>frame</p><script>${logger}plog('frame-load')
if(location.search.indexOf('handoff')>=0) setTimeout(function(){window.postMessage({source:'bsv-probe',cmd:'s5-frame'},'*')},800)</script>`),
  '/s3': () =>
    page('s3', `<pre id=out>s3</pre><script>${logger}
var early = window.__bsvProbeMain || null
plog('s3-inline', {csp:false, existed: !!early, early: early, readyState: document.readyState})
</script><script src="/s3.js"></script>`),
  '/s3-csp': () =>
    page('s3csp', `<pre id=out>s3 csp</pre><script src="/s3.js"></script>`, ''),
  '/s3.js': () => `${logger}
var early = window.__bsvProbeMain || null
plog('s3-external', {csp: location.pathname, existed: !!early, early: early, readyState: document.readyState, scripts: document.scripts.length})
`
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/log' && req.method === 'POST') {
      let body = ''
      req.on('data', d => (body += d))
      req.on('end', () => {
        fs.appendFileSync(LOG, body + '\n')
        res.writeHead(204, { 'access-control-allow-origin': '*' })
        res.end()
      })
      return
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST'
      })
      return res.end()
    }
    const route = routes[url.pathname]
    
    if (!route) {
      res.writeHead(404)
      return res.end('not found')
    }
    const headers = { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8', 'access-control-allow-origin': '*' }
    if (url.pathname === '/s3-csp') headers['content-security-policy'] = "script-src 'self'"
    res.writeHead(200, headers)
    res.end(route(url.searchParams))
  })
  .listen(PORT, '0.0.0.0', () => console.log(`probe server on ${PORT}, log ${LOG}`))
