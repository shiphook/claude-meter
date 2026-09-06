(function (){
'use strict';
const SOURCE='shiphook-claude-meter';
const HOST_ID='shiphook-claude-meter';
const PERSIST_KEY='shiphook_usage_snapshot';
let enabled=true;
let showCache=false;
let overlayLoaded=false;
let meterState=createEmptyState();
let lastOrgId=null;
let hydrateComplete=false;
function createEmptyState(){
const bucket=()=> ({count:0,tokensApprox:0 });
const usage=()=> ({utilization:0,percent:0 });
return{
updatedAt:Date.now(),
context:{tokensApprox:0,limit:200000,percent:0 },
breakdown:{tool_call:bucket(),web_search:bucket(),other:bucket() },
session:usage(),
weekly:usage(),
status:'waiting',
};
}
function readPrefs(){
return new Promise((resolve)=>{
try{
chrome.storage.local.get({enabled:true,showCache:false },(result)=>{
enabled=result.enabled  !== false;
showCache=result.showCache === true;
resolve({enabled,showCache });
});
}catch (_){
enabled=true;
showCache=false;
resolve({enabled,showCache });
}
});
}
function hydrateUsageSnapshot(){
return new Promise((resolve)=>{
try{
chrome.storage.local.get(PERSIST_KEY,(result)=>{
const snapshot=result[PERSIST_KEY];
if (snapshot  &&  typeof snapshot === 'object'){
if (snapshot.session) meterState.session={...meterState.session,...snapshot.session };
if (snapshot.weekly) meterState.weekly={...meterState.weekly,...snapshot.weekly };
if (snapshot.orgId) lastOrgId=snapshot.orgId;
meterState.updatedAt=Date.now();
}
hydrateComplete=true;
resolve();
});
}catch (_){
hydrateComplete=true;
resolve();
}
});
}
function persistUsageSnapshot(){
if (!hydrateComplete) return;
try{
const snapshot={
session:meterState.session,
weekly:meterState.weekly,
orgId:lastOrgId  ||  null,
updatedAt:Date.now(),
};
chrome.storage.local.set({[PERSIST_KEY]:snapshot });
}catch (_){}
}
try{
chrome.storage.onChanged.addListener((changes,area)=>{
if (area  !== 'local') return;
if (changes.enabled){
enabled=changes.enabled.newValue  !== false;
applyEnabled();
}
if (changes.showCache){
showCache=changes.showCache.newValue === true;
pushStateToOverlay();
}
});
}catch (_){}
function applyEnabled(){
if (enabled){
remountOverlayIfNeeded();
const host=document.getElementById(HOST_ID);
if (host) host.style.display='';
}else{
const host=document.getElementById(HOST_ID);
if (host) host.style.display='none';
}
}
function injectFetchHook(){}
function ensureHost(){
let host=document.getElementById(HOST_ID);
if (!host){
host=document.createElement('div');
host.id=HOST_ID;
host.setAttribute('data-shiphook','claude-meter');
host.setAttribute('role','region');
host.setAttribute('aria-label','Claude usage meter');
(document.documentElement  ||  document.body  ||  document).appendChild(host);
}
if (!enabled) host.style.display='none';
return host;
}
function stateForUi(){
const out={...meterState };
if (!showCache) delete out.cache;
// Always expose finite session/weekly percents for collapsed chip (Redline)
const sp=Number(out.session && out.session.percent);
const wp=Number(out.weekly && out.weekly.percent);
out.session={...(out.session||{}),percent:Number.isFinite(sp)?sp:0,utilization:Number(out.session&&out.session.utilization)||0};
out.weekly={...(out.weekly||{}),percent:Number.isFinite(wp)?wp:0,utilization:Number(out.weekly&&out.weekly.utilization)||0};
// Collapsed pill: session+weekly bars (not context %). Redline chip layout.
out.chip={
sessionPercent:out.session.percent,
weeklyPercent:out.weekly.percent,
sessionResetsInSec:out.session.resetsInSec,
weeklyResetsInSec:out.weekly.resetsInSec,
};
return out;
}
function pushStateToOverlay(){
if (!enabled) return;
const api=window.__SHIPHOOK_METER__;
if (api  &&  typeof api.setState === 'function') api.setState(stateForUi());
const host=document.getElementById(HOST_ID);
if (host){
try{
host.dispatchEvent(new CustomEvent('shiphook-meter:update',{detail:stateForUi() }));
}catch (_){}
}
}
function setState(partial){
const hadSessionOrWeekly=partial.session  ||  partial.weekly;
meterState={
...meterState,
...partial,
context:{...meterState.context,...(partial.context  || {}) },
breakdown:mergeBreakdown(meterState.breakdown,partial.breakdown),
session:{...meterState.session,...(partial.session  || {}) },
weekly:{...meterState.weekly,...(partial.weekly  || {}) },
updatedAt:Date.now(),
};
if (partial.cache  !== undefined) meterState.cache=partial.cache;
if (partial.model  !== undefined) meterState.model=partial.model;
if (partial.error  !== undefined) meterState.error=partial.error;
if (partial.status) meterState.status=partial.status;
if (hadSessionOrWeekly) persistUsageSnapshot();
pushStateToOverlay();
try{
chrome.runtime.sendMessage({
source:SOURCE,
type:'storage.set',
patch:{lastStatus:meterState.status,lastUpdatedAt:meterState.updatedAt },
});
}catch (_){}
}
function mergeBreakdown(prev,next){
if (!next) return prev;
const out={...prev };
for (const k of ['tool_call','web_search','other']){
if (next[k]) out[k]={...prev[k],...next[k] };
}
return out;
}
window.addEventListener('message',(event)=>{
if (event.source  !== window) return;
const msg=event.data;
if (!msg  ||  msg.source  !== SOURCE) return;
if (msg.type === 'ready'){
setState({status:meterState.status === 'error' ? 'error' :'waiting' });
scheduleUsagePoll();
return;
}
if (msg.type === 'org'  &&  msg.payload  &&  msg.payload.orgId){
const newOrgId=String(msg.payload.orgId);
if (newOrgId  !== lastOrgId){
lastOrgId=newOrgId;
persistUsageSnapshot();
requestUsageFetch();
}
scheduleUsagePoll();
return;
}
if (msg.type === 'usage'){
handleUsagePayload(msg.payload);
return;
}
if (msg.type === 'sse') handleSsePayload(msg.payload);
});
try{
window.postMessage({source:SOURCE,type:'request_ready' },'*');
}catch (_){}
function handleUsagePayload(payload){
if (!payload) return;
const kind=payload.kind;
const data=payload.data;
if (kind === 'fetch_error'){
setState({
status:meterState.session.percent  ||  meterState.weekly.percent ? 'ok' :'waiting',
error:payload.error  ||  (payload.status ? 'usage_http_' + payload.status :'usage_fetch_error'),
});
return;
}
if (kind === 'message_limit'  ||  kind === 'polled'  ||  kind === 'json'){
const normalized=normalizeUsageInline(data);
if (normalized  &&  normalized.empty){
setState({status:'waiting',error:undefined });
}else if (normalized){
setState({
session:normalized.session,
weekly:normalized.weekly,
status:'ok',
error:undefined,
});
}
if (kind === 'json'  &&  data  &&  (data.chat_messages  ||  data.messages)){
applyConversationTree(data);
}
}
}
function handleSsePayload(payload){
if (!payload) return;
if (payload.kind === 'tool'){
const key=payload.toolKind === 'web_search' ? 'web_search' :'tool_call';
const prev=meterState.breakdown[key]  || {count:0,tokensApprox:0 };
const addTokens=Math.ceil((payload.approxChars  ||  0) / 4);
setState({
breakdown:{
[key]:{count:prev.count + 1,tokensApprox:(prev.tokensApprox  ||  0) + addTokens },
},
status:'ok',
});
}
if (payload.kind === 'conversation_json'  &&  payload.data){
applyConversationTree(payload.data);
}
if (payload.kind === 'stream_end'  &&  payload.url){
const m=String(payload.url).match(/chat_conversations\/([0-9a-fA-F-]{36})/);
if (m) requestConversationTree(m[1]);
}
}
function applyConversationTree(tree){
try{
const messages=
tree.chat_messages  || 
tree.messages  || 
(tree.conversation  &&  tree.conversation.chat_messages)  || 
[];
if (!Array.isArray(messages)) return;
const byUuid=new Map();
for (const msg of messages){
const id=msg.uuid  ||  msg.id;
if (id) byUuid.set(String(id),msg);
}
const leafId=tree.current_leaf_message_uuid  ||  tree.currentLeafMessageUuid  ||  null;
const trunk=[];
if (leafId  &&  byUuid.has(String(leafId))){
let cur=byUuid.get(String(leafId));
const seen=new Set();
while (cur  &&  !seen.has(cur)){
seen.add(cur);
trunk.push(cur);
const parentId=cur.parent_message_uuid  ||  cur.parentMessageUuid;
cur=parentId ? byUuid.get(String(parentId)) :null;
}
trunk.reverse();
}else{
trunk.push(...messages);
}
const breakdown={
tool_call:{count:0,tokensApprox:0 },
web_search:{count:0,tokensApprox:0 },
other:{count:0,tokensApprox:0 },
};
let totalChars=0;
function blockText(b){
if (!b) return '';
if (typeof b === 'string') return b;
if (typeof b.text === 'string') return b.text;
if (typeof b.content === 'string') return b.content;
try{return JSON.stringify(b);}catch{return '';}
}
function classify(b){
if (!b  ||  typeof b  !== 'object') return 'other';
const type=String(b.type  ||  '').toLowerCase();
const name=String(b.name  ||  b.tool_name  ||  '').toLowerCase();
if (name.includes('web_search')  ||  type.includes('web_search')) return 'web_search';
if (type === 'tool_use'  ||  type === 'tool_result'  ||  type === 'tool_call'  ||  type === 'server_tool'){
return 'tool_call';
}
return 'other';
}
for (const msg of trunk){
const content=msg.content  ||  msg.contents  ||  [];
const blocks=Array.isArray(content)
? content
:typeof content === 'string'
? [{type:'text',text:content }]
:[];
for (const b of blocks){
const t=blockText(b);
totalChars +=t.length;
const key=classify(b);
breakdown[key].count +=1;
breakdown[key].tokensApprox +=Math.ceil(t.length / 4);
}
}
const model=
tree.model  ||  tree.chat_model  ||  (tree.conversation  &&  tree.conversation.model)  ||  meterState.model;
const limit=resolveLimit(model,meterState.context.limit);
const tokensApprox=Math.ceil(totalChars / 4);
const percent=limit > 0 ? Math.min(100,(tokensApprox / limit) * 100) :0;
let cache;
try{
let lastAssistant=null;
for (const msg of trunk){
const role=String(msg.role  ||  msg.sender  ||  '').toLowerCase();
if (role === 'assistant'  ||  role === 'bot'){
const ts=Date.parse(msg.created_at  ||  msg.updated_at  ||  '');
if (ts  &&  (!lastAssistant  ||  ts > lastAssistant)) lastAssistant=ts;
}
}
if (lastAssistant){
const expiresAt=lastAssistant + 5 * 60 * 1000;
const remainingMs=expiresAt - Date.now();
if (remainingMs > 0) cache={expiresAt,remainingMs };
}
}catch (_){}
const patch={model,context:{tokensApprox,limit,percent },breakdown,status:'ok' };
if (cache) patch.cache=cache;
setState(patch);
}catch (err){
setState({status:'error',error:err  &&  err.message ? err.message :'tree_walk_error' });
}
}
function resolveLimit(model,fallback){
if (!model) return fallback  ||  200000;
const s=String(model).toLowerCase();
if (/\b1m\b|1000000/.test(s)) return 1000000;
if (/\b500k\b|500000/.test(s)) return 500000;
if (/\b200k\b|200000/.test(s)) return 200000;
return fallback  ||  200000;
}
function normalizeUsageInline(apiJson){
if (apiJson==null) return{empty:true };
if (typeof apiJson  !== 'object') return null;
const emptyB=()=> ({utilization:0,percent:0 });
const result={session:emptyB(),weekly:emptyB() };
function num(...vals){
for (const v of vals){
if (v==null  ||  v === '') continue;
const n=Number(v);
if (!Number.isNaN(n)  &&  Number.isFinite(n)) return n;
}
return null;
}
function present(...vals){
for (const v of vals){
if (v !=null  &&  v  !== '') return v;
}
return null;
}
function normalizeResetsAt(raw){
const out={};
if (raw==null  ||  raw === '') return out;
let ms=null;
if (typeof raw === 'number'  &&  Number.isFinite(raw)){
ms=raw < 1e12 ? raw * 1000 :raw;
out.resetsAt=ms;
}else{
const s=String(raw).trim();
if (!s) return out;
const asNum=Number(s);
if (!Number.isNaN(asNum)  &&  Number.isFinite(asNum)  &&  /^\d+(\.\d+)?$/.test(s)){
ms=asNum < 1e12 ? asNum * 1000 :asNum;
out.resetsAt=ms;
}else{
const parsed=Date.parse(s);
if (!Number.isNaN(parsed)){
ms=parsed;
out.resetsAt=s;
}else{
out.resetsAt=s;
}
}
}
if (ms !=null) out.resetsInSec=Math.max(0,Math.floor((ms - Date.now()) / 1000));
return out;
}
function bucket(b){
if (!b  ||  typeof b  !== 'object') return null;
let util=num(b.utilization,b.util);
if (util==null){
const used=num(b.used,b.usage,b.consumed);
const limit=num(b.limit,b.max,b.quota);
if (used !=null  &&  limit) util=used / limit;
}
if (util==null  &&  b.percent !=null) util=Number(b.percent) / 100;
const resetInfo=normalizeResetsAt(
present(b.resets_at,b.resetsAt,b.reset_at,b.resetAt,b.resets)
);
let resetsInSec=num(b.resets_in_seconds,b.resetsInSec,b.resets_in_sec,b.seconds_remaining);
if (resetsInSec==null  &&  resetInfo.resetsInSec !=null) resetsInSec=resetInfo.resetsInSec;
if (util==null){
if (resetInfo.resetsAt==null  &&  resetsInSec==null) return null;
return{
utilization:0,
percent:0,
...(resetInfo.resetsAt !=null ?{resetsAt:resetInfo.resetsAt }:{}),
...(resetsInSec !=null ?{resetsInSec }:{}),
};
}
const clamped=Math.min(1,Math.max(0,util));
const out={
utilization:clamped,
percent:Math.min(100,Math.max(0,num(b.percent,clamped * 100) ?? clamped * 100)),
};
if (resetInfo.resetsAt !=null) out.resetsAt=resetInfo.resetsAt;
if (resetsInSec !=null) out.resetsInSec=resetsInSec;
return out;
}
const root=
apiJson.message_limit  || 
apiJson.messageLimit  || 
(apiJson.type === 'message_limit' ? apiJson :apiJson);
const windows=(root  &&  root.windows)  ||  apiJson.windows  ||  null;
const sessionSrc=
(windows  &&  (windows['5h']  ||  windows['5H']  ||  windows.session))  || 
root.five_hour  ||  root.fiveHour  ||  root.session  ||  root.rate_limit_0  || 
apiJson.five_hour  ||  apiJson.session;
const weeklySrc=
(windows  &&  (windows['7d']  ||  windows['7D']  ||  windows.weekly))  || 
root.seven_day  ||  root.sevenDay  ||  root.weekly  ||  root.rate_limit_1  || 
apiJson.seven_day  ||  apiJson.weekly;
const s=bucket(sessionSrc);
const w=bucket(weeklySrc);
if (!s  &&  !w){
const flat=bucket(root);
if (!flat) return{empty:true };
result.session=flat;
return result;
}
if (s) result.session=s;
if (w) result.weekly=w;
return result;
}
function readLastActiveOrg(){
try{
const cookies=document.cookie.split(';');
for (const c of cookies){
const [k,...rest]=c.trim().split('=');
if (k === 'lastActiveOrg'  ||  k === 'lastActiveOrganization'){
return decodeURIComponent(rest.join('='));
}
}
}catch (_){}
try{
const ls=localStorage.getItem('lastActiveOrg')  ||  localStorage.getItem('lastActiveOrganization');
if (ls) return ls;
}catch (_){}
return null;
}
let pollTimer=null;
function scheduleUsagePoll(){
if (pollTimer) return;
const tick=()=>{
requestUsageFetch();
pollTimer=setTimeout(tick,60_000);
};
pollTimer=setTimeout(tick,2_000);
}
function requestUsageFetch(){
const org=lastOrgId  ||  readLastActiveOrg();
if (!org){
setState({status:meterState.status === 'ok' ? 'ok' :'waiting' });
return;
}
const url='https://claude.ai/api/organizations/' + encodeURIComponent(org) + '/usage';
window.postMessage({source:SOURCE,type:'request_usage_fetch',payload:{url }},'*');
}
function requestConversationTree(conversationId){
if (!conversationId) return;
const org=lastOrgId  ||  readLastActiveOrg();
let url;
if (org){
url=
'https://claude.ai/api/organizations/' +
encodeURIComponent(org) +
'/chat_conversations/' +
encodeURIComponent(conversationId) +
'?tree=True';
}else{
url=
'https://claude.ai/api/chat_conversations/' +
encodeURIComponent(conversationId) +
'?tree=True';
}
window.postMessage({source:SOURCE,type:'request_usage_fetch',payload:{url }},'*');
}
function remountOverlayIfNeeded(){
if (!enabled) return;
const host=ensureHost();
if (host  &&  !host.shadowRoot){
try{
if (typeof globalThis.__SHIPHOOK_METER_MOUNT__ === 'function'){
globalThis.__SHIPHOOK_METER_MOUNT__();
}
}catch (_){}
}
pushStateToOverlay();
}
let remountRaf=0;
function startRemountLoop(){
if (remountRaf) return;
const tick=()=>{
remountRaf=0;
if (enabled) remountOverlayIfNeeded();
remountRaf=requestAnimationFrame(tick);
};
remountRaf=requestAnimationFrame(tick);
}
function watchHost(){
const obs=new MutationObserver(()=>{
if (!enabled) return;
const host=document.getElementById(HOST_ID);
if (!host  ||  !host.shadowRoot) remountOverlayIfNeeded();
});
obs.observe(document.documentElement,{childList:true,subtree:true });
}
function watchUrlChanges(){
let lastUrl=location.href;
const checkUrl=()=>{
const currentUrl=location.href;
if (currentUrl  !== lastUrl){
lastUrl=currentUrl;
requestUsageFetch();
}
};
window.addEventListener('popstate',checkUrl,{passive:true });
const originalPushState=history.pushState;
const originalReplaceState=history.replaceState;
if (originalPushState){
history.pushState=function(...args){
const result=originalPushState.apply(this,args);
checkUrl();
return result;
};
}
if (originalReplaceState){
history.replaceState=function(...args){
const result=originalReplaceState.apply(this,args);
checkUrl();
return result;
};
}
}
injectFetchHook();
async function boot(){
await Promise.all([readPrefs(),hydrateUsageSnapshot()]);
if (enabled){
remountOverlayIfNeeded();
setTimeout(()=> remountOverlayIfNeeded(),0);
setTimeout(()=> remountOverlayIfNeeded(),250);
setTimeout(()=> remountOverlayIfNeeded(),1000);
}
watchHost();
startRemountLoop();
requestUsageFetch();
scheduleUsagePoll();
watchUrlChanges();
try{
window.postMessage({source:SOURCE,type:'request_ready' },'*');
}catch (_){}
}
if (document.readyState === 'loading'){
document.addEventListener('DOMContentLoaded',()=>{boot();},{once:true });
}else{
boot();
}
})();
