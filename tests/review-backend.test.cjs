'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const U=require(path.join(root,'services/timetable-utils'));
const {createStudyTools}=require(path.join(root,'services/agent/study-tools'));
const {LocalAgentRuntime}=require(path.join(root,'services/agent/local-agent-runtime'));
const {CampusTimetableService}=require(path.join(root,'services/campus-timetable-service'));
const {CampusDebugLog}=require(path.join(root,'services/campus-debug-log'));
const parser=require(path.join(root,'services/chaoxing/page-parser'));
const provider=require(path.join(root,'services/agent/model-provider'));
const table=()=>U.normalize({enabled:true,termName:'独立验收',week1Monday:'2026-10-26',totalWeeks:16,periods:[{section:1,startTime:'08:00',endTime:'08:45'}],courses:[{name:'软件工程',dayOfWeek:2,startSection:1,endSection:1,weeks:'1-16(单)',location:'示例201'}]});
const signal=()=>new AbortController().signal;
let server,base,handler;
test.before(async()=>{server=http.createServer(async(req,res)=>{let data='';for await(const c of req)data+=c;await handler(req,res,JSON.parse(data||'{}'));});await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port+'/v1';});
test.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
const config=()=>({provider:'custom',api_base:base,api_key:'review-http-key',model:'review-model',timeout_seconds:2,max_rounds:4});
const reply=(res,message,reason='stop')=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:reason,message}]}));};
const tools=(t=table())=>createStudyTools({getTimetable:()=>({read:()=>t}),getChaoxing:()=>({listHomework:async()=>({ok:true,items:[]})})});
test('课表周次解析、日期校验及缺失信息提示',()=>{
 assert.deepEqual(table().courses[0].weeks,[1,3,5,7,9,11,13,15]);
 assert.throws(()=>U.normalize({...table(),week1Monday:'2026-10-27'}),/周一/);
 assert.throws(()=>U.normalize({...table(),courses:[{...table().courses[0],weeks:'1-20'}]}),/超出/);
 assert.ok(U.warnings({...table(),week1Monday:null,periods:[]}).some(s=>s.includes('第一教学周')));
});
test('只读工具拒绝未注册工具、多余参数及无效日期',async()=>{
 const t=tools();assert.equal((await t.execute('shell','{}',signal())).code,'UNKNOWN_TOOL');
 assert.equal((await t.execute('get_current_time','{"extra":true}',signal())).ok,false);
 assert.equal((await t.execute('get_timetable','{"date":"2026-02-30"}',signal())).ok,false);
});
test('课表按星期及教学周筛选，缺失课表不被解释为无课',async()=>{
 assert.equal((await tools().execute('get_timetable','{"date":"2026-10-27"}',signal())).courses.length,1);
 assert.equal((await tools().execute('get_timetable','{"date":"2026-11-03"}',signal())).courses.length,0);
 assert.equal((await tools(null).execute('get_timetable','{}',signal())).code,'TIMETABLE_UNAVAILABLE');
 const incomplete=await tools({...table(),week1Monday:null}).execute('get_timetable','{"date":"2026-10-27"}',signal());
 assert.equal(incomplete.teachingWeek,null);assert.ok(incomplete.warnings.length);
});
test('真实本地HTTP：模型请求头、工具往返和完整轮次',async()=>{
 let calls=0;handler=async(req,res,body)=>{assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer review-http-key');calls++;
 if(calls===1)reply(res,{role:'assistant',content:null,tool_calls:[{id:'c1',type:'function',function:{name:'get_timetable',arguments:'{"date":"2026-10-27"}'}}]});
 else {assert.equal(JSON.parse(body.messages.at(-1).content).courses[0].name,'软件工程');reply(res,{role:'assistant',content:'课表查询完成'});}};
 const result=await new LocalAgentRuntime({tools:tools()}).send({query:'查今天课表',history:[],config:config(),signal:signal()});
 assert.equal(calls,2);assert.equal(result.answer,'课表查询完成');assert.deepEqual(result.messages.map(m=>m.role),['user','assistant','tool','assistant']);
});
test('HTTP鉴权失败和不完整输出不能被当作成功回复',async()=>{
 handler=async(req,res)=>{res.statusCode=401;res.end('{}');};
 await assert.rejects(provider.complete({config:config(),messages:[],tools:[],signal:signal()}),/401/);
 handler=async(req,res)=>reply(res,{role:'assistant',content:'被截断'},'length');
 await assert.rejects(provider.complete({config:config(),messages:[],tools:[],signal:signal()}),/长度限制/);
});
test('取消真实HTTP请求后Runtime结束，不再继续调用工具',async()=>{
 let arrive;const started=new Promise(r=>arrive=r);handler=async()=>arrive();const ctl=new AbortController();
 const pending=new LocalAgentRuntime({tools:tools()}).send({query:'等待',history:[],config:config(),signal:ctl.signal});await started;ctl.abort();
 await assert.rejects(pending,/已停止/);
});
test('课程歧义暂停剩余工具并补全协议结果',async()=>{
 const resultTools={definitions:[],label:n=>n,execute:async()=>({ok:false,requires_user_input:true,question:'请确认课程'})};let count=0;
 resultTools.execute=async()=>{count++;return {ok:false,requires_user_input:true,question:'请确认课程'}};
 handler=async(req,res)=>reply(res,{role:'assistant',content:null,tool_calls:[1,2].map(i=>({id:'c'+i,type:'function',function:{name:'list_homework',arguments:'{"course":"软件"}'}}))});
 const result=await new LocalAgentRuntime({tools:resultTools}).send({query:'查询作业',history:[],config:config(),signal:signal()});
 assert.equal(count,1);assert.equal(result.answer,'请确认课程');assert.equal(result.messages.filter(m=>m.role==='tool').length,2);assert.equal(JSON.parse(result.messages[3].content).code,'WAITING_FOR_USER');
});
test('模型反复调用工具时按预算结束',async()=>{
 handler=async(req,res)=>reply(res,{role:'assistant',content:null,tool_calls:[{id:'clock',type:'function',function:{name:'get_current_time',arguments:'{}'}}]});
 await assert.rejects(new LocalAgentRuntime({tools:tools()}).send({query:'循环',history:[],config:{...config(),max_rounds:2},signal:signal()}),/次数上限/);
});
test('课表保存失败不覆盖已有有效课表，校园背景仅使用已保存表',()=>{
 const dir=fs.mkdtempSync(path.join(__dirname,'unit-table-'));const s=new CampusTimetableService(dir,()=>({}));
 s.save({table:table()});assert.throws(()=>s.save({table:{...table(),week1Monday:'2026-10-27'}}),/周一/);
 assert.equal(s.read().week1Monday,'2026-10-26');assert.ok(s.getCampusQuery('今天有课吗',new Date('2026-10-27T00:00:00Z')).includes('软件工程'));
 s.clear();assert.equal(s.read(),null);fs.rmdirSync(dir);
});
test('校园Key不会读取外部环境变量，日志再次导出仍脱敏',()=>{
 process.env.ZXL_API_KEY='review-external-key';const campus=require(path.join(root,'services/campus-agent-service'));
 assert.equal(campus.getApiKey({api_key:''}),'');assert.equal(campus.getApiKey({api_key:' own-key '}),'own-key');
 const log=new CampusDebugLog(__dirname);const result=log.sanitize({api_key:'review-http-key',text:'Bearer abcdefgh token=abcdefgh'},['review-http-key']);
 assert.ok(!JSON.stringify(result).includes('review-http-key'));assert.ok(!JSON.stringify(result).includes('abcdefgh'));
});
test('学习通无可信空列表标记时明确报错',()=>{
 assert.throws(()=>parser.parseHomework('<html><body>暂时无法加载页面</body></html>'),/不能判断/);
 assert.equal(parser.parseHomework('<html><body>暂无作业</body></html>').confirmedEmpty,true);
});
test('朗读控件仅在合成/播放期间出现，停止与迟到结果不恢复播放',async()=>{
 const button={hidden:true};let complete;const pending=new Promise(r=>complete=r);
 const fakeWindow={electronAPI:{stopSpeech(){},synthesizeSpeech:()=>pending},setPetSpeaking(){},setLipSync(){}};
 const context={window:fakeWindow,document:{getElementById:()=>button,addEventListener(){},removeEventListener(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},Uint8Array,console};
 vm.runInNewContext(fs.readFileSync(path.join(root,'renderer/campus-speech.js'),'utf8'),context);
 const speech=new fakeWindow.CampusSpeech(e=>{throw Error(e)});speech.plainText=()=> '验收';speech.prepare=()=>{};speech.context={resume:async()=>{},decodeAudioData:async()=>({})};speech.analyser={};
 const promise=speech.speak('验收');assert.equal(button.hidden,false);speech.stop();assert.equal(button.hidden,true);complete({ok:true,audio:[0]});await promise;assert.equal(button.hidden,true);
});
