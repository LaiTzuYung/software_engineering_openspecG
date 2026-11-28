export const studentPage = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>學生搶答</title>
<style>:root{color-scheme:dark;--bg:#0b1220;--surface:#151f31;--surface-raised:#1d2a40;--border:#34445d;--text:#edf3fb;--muted:#acbbcf;--primary:#3978e8;--primary-hover:#4b89fa;--success:#36c98a;--success-bg:#103b32;--danger:#f07178;--danger-bg:#48232d;--warning:#f2c66d}*{box-sizing:border-box}body{font:21px/1.6 system-ui,sans-serif;max-width:82rem;margin:2rem auto;padding:0 1.25rem;background:var(--bg);color:var(--text)}main{width:min(100%,72rem);margin-inline:auto}h1{font-size:clamp(2rem,4vw,2.6rem);line-height:1.2;margin:0 0 1.5rem}h2{font-size:1.55rem;margin:.3rem 0 1rem}h3{font-size:1.3rem;margin:.25rem 0 .65rem}p{margin:.55rem 0}label{display:block;margin:1rem 0;color:var(--muted)}input,select,button{font:inherit;padding:.7rem .85rem;border:1px solid var(--border);border-radius:.55rem;background:var(--surface-raised);color:var(--text)}input,select{max-width:100%}input{width:min(100%,32rem)}input:focus,select:focus,button:focus-visible{outline:3px solid #83b2ff;outline-offset:2px}button{cursor:pointer;margin:.25rem 0;background:#3a4659;border-color:#596b85;font-weight:700}button:hover:not(:disabled){filter:brightness(1.12)}button:disabled{cursor:not-allowed;opacity:.42;filter:grayscale(.7);box-shadow:none}#join-button,#activity-content button{background:var(--primary);border-color:var(--primary);color:white}#leave-button{background:#3a4659}#join-form{padding:1.25rem 1.4rem;border:1px solid var(--border);border-radius:1rem;background:var(--surface);box-shadow:0 12px 30px #0005}.card{border:1px solid var(--border);border-radius:1rem;padding:1.25rem 1.4rem;margin:1rem 0;background:var(--surface);box-shadow:0 10px 26px #0004}.answer-row{display:block;margin:.9rem 0}.stage-badge{display:inline-flex;align-items:center;width:fit-content;padding:.3rem .85rem;border:1px solid;border-radius:999px;font-size:1.05rem;font-weight:800;letter-spacing:.02em}.stage-preparing{color:#f2c66d;background:#41331b;border-color:#80652c}.stage-buzzing{color:#9fc4ff;background:#183868;border-color:#356bc0}.stage-ended{color:#c4b4ff;background:#30254d;border-color:#66529a}.submitted{color:var(--success);font-weight:800}.error{color:#ff969b;font-weight:800}#message{min-height:1.8em;padding:.45rem .7rem;border-radius:.5rem}#message.submitted{background:var(--success-bg)}#message.error{background:var(--danger-bg)}.card:has(> .submitted){border-color:#258c69;background:linear-gradient(135deg,#12372f,var(--surface) 65%)}.card:has(> .submitted) h3{color:#a6f1d0}.result-card:not(.own-success):has(> .submitted){border-color:var(--border);background:var(--surface)}.result-card:not(.own-success):has(> .submitted) h3{color:var(--text)}.answer-details{margin-top:.75rem;border:1px solid #258c69;border-radius:.65rem;background:#102b27}.answer-details summary{padding:.55rem .75rem;color:#a6f1d0;font-weight:800;cursor:pointer}.answer-details ul{margin:.3rem 0;padding:.25rem 1.8rem .75rem}.answer-details li{margin:.25rem 0;color:var(--text)}.result-card.own-success{border:2px solid var(--success);background:linear-gradient(135deg,#12372f,var(--surface) 68%);box-shadow:0 0 0 2px #36c98a33,0 14px 34px #0006}.result-group{font-size:1.12em}.result-answer{padding:.35rem .65rem;border-left:3px solid #4d78b8;background:#18263a}.success-banner{padding:.6rem .8rem;border:1px solid #36c98a;border-radius:.6rem;background:var(--success-bg);color:#a6f1d0;font-size:1.15em;font-weight:900}#activity-content{margin-top:1rem}#leave-button[hidden]{display:none}@media(max-width:38rem){body{margin:1rem auto;padding:0 .85rem;font-size:19px}.card,#join-form{padding:1rem}input{width:100%}}</style></head>
<body><main><h1>學生搶答</h1><form id="join-form"><p>請輸入活動代碼並選擇組別加入活動。</p><label>活動代碼 <input id="activity-code" name="code" inputmode="numeric" maxlength="4" autocomplete="off" aria-label="活動代碼"></label><label>組別 <select id="group-id" name="group" disabled><option value="">請選擇組別</option></select></label><button id="join-button" type="submit" disabled>加入</button></form><button id="leave-button" type="button" hidden>離開活動</button><p id="message" aria-live="polite"></p><section id="activity-content" aria-live="polite"></section></main>
<script src="/socket.io/socket.io.js"></script><script>
const joinForm=document.querySelector('#join-form'),codeInput=document.querySelector('#activity-code'),groupSelect=document.querySelector('#group-id'),joinButton=document.querySelector('#join-button'),leaveButton=document.querySelector('#leave-button'),message=document.querySelector('#message'),content=document.querySelector('#activity-content');let lookupId=0,socket=null,currentView=null;
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}
function resetGroups(){groupSelect.replaceChildren(new Option('請選擇組別',''));groupSelect.disabled=true;joinButton.disabled=true}
function clearSavedIdentity(){sessionStorage.removeItem('liveBuzzerSession');sessionStorage.removeItem('liveBuzzerActivityCode');sessionStorage.removeItem('liveBuzzerGroupId')}
function rejectionText(reason){return ({'activity-not-buzzing':'目前階段不能作答。','blank-answer':'答案不可空白。','answer-too-long':'單一答案超過 200 字，請縮短後再送出。','already-submitted':'本組此題已送出，不能重複提交。','incomplete-answer-set':'題組答案不完整，請填完所有小題。','unknown-question':'找不到此題，請重新整理頁面。','unknown-group':'找不到本組，請重新加入活動。','activity-unavailable':'活動目前無法使用。'})[reason]||'提交遭拒，請確認答案與活動狀態。'}
function appendOwnAnswerDetails(card,question){const details=element('details',undefined,'answer-details');details.append(element('summary','查看本組答案'));const list=element('ul');for(const subquestion of question.subquestions){const label=question.subquestions.length>1?'小題 '+subquestion.number+'：':'答案：';list.append(element('li',label+(subquestion.answer??'')))}details.append(list);card.append(details)}
function render(view){
  const drafts={};
  for(const form of content.querySelectorAll('form[data-question-number]')){
    const questionNumber=form.dataset.questionNumber;
    drafts[questionNumber]={};
    for(const input of form.querySelectorAll('input[data-subquestion-number]'))drafts[questionNumber][input.dataset.subquestionNumber]=input.value;
  }
  currentView=view;
  content.replaceChildren();
  const heading=element('h2',view.stage==='preparing'?'準備中':view.stage==='buzzing'?'搶答中':'活動已結束','stage-badge stage-'+view.stage);
  content.append(heading);
  content.append(element('p','排名規則：'+view.rankingRule.name+(view.rankingRule.explanation?'（'+view.rankingRule.explanation+'）':''),'ranking-rule'));
  if(view.stage==='preparing'){
    const card=element('article',undefined,'card');
    card.append(element('p','本組：'+view.group.name),element('p','等待老師開始','muted'));
    content.append(card);
    return;
  }
  content.append(element('p','本組：'+view.group.name));
  if(view.stage==='ended'){
    for(const question of view.questions){
      const result=(view.results||[]).find(item=>item.questionNumber===question.number);
      const ownSuccess=!!result?.successfulGroup&&result.successfulGroup.id===view.group.id;
      const card=element('article',undefined,ownSuccess?'card result-card own-success':'card result-card');
      card.append(element('h3','第 '+question.number+' 題'));
      if(question.description)card.append(element('p',question.description));
      if(result?.successfulGroup){
        card.append(element('p','成功組別：'+result.successfulGroup.name,'result-group'));
        for(const answer of result.answers||[]){
          const prefix=(result.answers?.length||0)>1?'小題 '+answer.subquestionNumber+'：':'成功答案：';
          card.append(element('p',prefix+answer.answer,'result-answer'));
        }
        if(ownSuccess)card.append(element('p','本組搶答成功！','success-banner'));
      }else{
        card.append(element('p','本題沒有成功組別','muted'));
        if(result?.explanation)card.append(element('p',result.explanation,'muted result-explanation'));
      }
      const ownSubmitted=question.subquestions.length>0&&question.subquestions.every(item=>item.submitted);
      if(ownSubmitted){
        card.append(element('p','本組已送出','submitted'));
        appendOwnAnswerDetails(card,question);
      }else{
        card.append(element('p','本組未作答','muted'));
      }
      content.append(card);
    }
    return;
  }
  if(view.stage==='buzzing'){
    for(const question of view.questions){
      const card=element('article',undefined,'card');
      card.append(element('h3','第 '+question.number+' 題'));
      if(question.description)card.append(element('p',question.description));
      const submitted=question.subquestions.length>0&&question.subquestions.every(item=>item.submitted);
      if(submitted){
        card.append(element('p','本組已送出','submitted'));
        appendOwnAnswerDetails(card,question);
        content.append(card);
        continue;
      }
      const form=element('form');
      form.dataset.questionNumber=String(question.number);
      const answerInputs=[];
      for(const subquestion of question.subquestions){
        const label=element('label',question.subquestions.length===1?'答案':'小題 '+subquestion.number,'answer-row');
        const input=element('input');
        input.type='text';
        input.autocomplete='off';
        input.dataset.subquestionNumber=String(subquestion.number);
        input.value=drafts[question.number]?.[subquestion.number]||'';
        label.append(input);
        form.append(label);
        answerInputs.push(input);
      }
      const submit=element('button','送出');
      submit.type='submit';
      submit.disabled=true;
      const validate=()=>{submit.disabled=answerInputs.some(input=>input.value.trim()==='')};
      for(const input of answerInputs)input.addEventListener('input',validate);
      validate();
      form.append(submit);
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        validate();
        if(submit.disabled||!socket)return;
        submit.disabled=true;
        const answers={};
        for(const input of answerInputs)answers[input.dataset.subquestionNumber]=input.value;
        try{
          const result=await socket.emitWithAck('student:submit',{questionNumber:question.number,answers});
          if(!result.ok){message.textContent=rejectionText(result.reason);message.className='error';validate();return}
          message.textContent='答案已送出';
          message.className='submitted';
          const snapshot=await socket.emitWithAck('student:get-state');
          if(snapshot.ok)render(snapshot.view);
        }catch{
          message.textContent='連線中斷，請確認網路後重試。';
          message.className='error';
          validate();
        }
      });
      card.append(form);
      content.append(card);
    }
  }
}
function connectStudent(token){joinForm.hidden=true;leaveButton.hidden=false;socket=io({auth:{role:'student',sessionToken:token}});socket.on('activity:student-view',view=>{message.textContent='';message.className='';render(view)});socket.on('connect',async()=>{try{const snapshot=await socket.emitWithAck('student:get-state');if(!snapshot.ok){clearSavedIdentity();socket.disconnect();joinForm.hidden=false;leaveButton.hidden=true;message.textContent='學生身分已失效，請重新加入活動。';message.className='error';return}render(snapshot.view)}catch{message.textContent='無法取得活動狀態，請稍後重試。';message.className='error'}});socket.on('connect_error',()=>{message.textContent='無法恢復學生連線，請重新加入活動。';message.className='error';joinForm.hidden=false})}
function leaveActivity(){clearSavedIdentity();if(socket){const oldSocket=socket;socket=null;oldSocket.removeAllListeners();oldSocket.disconnect()}currentView=null;content.replaceChildren();joinForm.hidden=false;leaveButton.hidden=true;codeInput.value='';resetGroups();message.textContent='';message.className=''}
leaveButton.addEventListener('click',leaveActivity);
groupSelect.addEventListener('change',()=>{joinButton.disabled=groupSelect.value===''});
codeInput.addEventListener('input',async()=>{const requestId=++lookupId,code=codeInput.value;clearSavedIdentity();currentView=null;content.replaceChildren();resetGroups();message.textContent='';message.className='';if(!/^[0-9]{4}$/.test(code))return;try{const response=await fetch('/api/student/activity?code='+encodeURIComponent(code));const data=await response.json();if(requestId!==lookupId||codeInput.value!==code)return;if(!response.ok||!data.found){message.textContent='找不到此活動代碼';message.className='error';return}for(const group of data.groups)groupSelect.add(new Option(group.name,group.id));groupSelect.disabled=false}catch{if(requestId===lookupId){message.textContent='查詢失敗，請重試。';message.className='error'}}});
joinForm.addEventListener('submit',async event=>{event.preventDefault();const activityCode=codeInput.value,groupId=groupSelect.value;if(!/^[0-9]{4}$/.test(activityCode)||!groupId){joinButton.disabled=true;return}joinButton.disabled=true;try{const response=await fetch('/api/student/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({activityCode,groupId})});const data=await response.json();if(!response.ok)throw Error(data.error);sessionStorage.setItem('liveBuzzerSession',data.sessionToken);sessionStorage.setItem('liveBuzzerActivityCode',data.activityCode);sessionStorage.setItem('liveBuzzerGroupId',data.groupId);message.textContent='';connectStudent(data.sessionToken)}catch(error){message.textContent=error.message==='activity-not-found'?'找不到此活動代碼':error.message==='group-not-found'?'此組別不存在':'加入失敗，請重新選擇活動與組別。';message.className='error';joinButton.disabled=groupSelect.value===''}});
const savedToken=sessionStorage.getItem('liveBuzzerSession');if(savedToken)connectStudent(savedToken);
</script></body></html>`;

export const teacherLoginPage = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>老師驗證</title>
<style>:root{color-scheme:dark;--bg:#0b1220;--surface:#151f31;--surface-raised:#1d2a40;--border:#34445d;--text:#edf3fb;--muted:#acbbcf;--primary:#3978e8}*{box-sizing:border-box}body{min-height:100vh;display:grid;place-items:center;margin:0;padding:1.25rem;background:var(--bg);color:var(--text);font:21px/1.6 system-ui,sans-serif}main{width:min(100%,30rem);padding:2rem;border:1px solid var(--border);border-radius:1rem;background:var(--surface);box-shadow:0 16px 38px #0006}h1{margin:0 0 1.5rem;font-size:2rem}label{display:block;margin:.8rem 0;color:var(--muted)}input,button{width:100%;font:inherit;padding:.7rem .85rem;border:1px solid var(--border);border-radius:.55rem;background:var(--surface-raised);color:var(--text)}input:focus,button:focus-visible{outline:3px solid #83b2ff;outline-offset:2px}button{margin-top:.8rem;cursor:pointer;background:var(--primary);border-color:var(--primary);font-weight:800}#message{min-height:1.8em;color:#ff969b}</style></head><body><main><h1>老師登入</h1><form id="login"><label>老師 PIN <input name="pin" type="password" required></label><button>登入</button></form><p id="message"></p>
<script>document.querySelector('#login').onsubmit=async e=>{e.preventDefault();const pin=new FormData(e.target).get('pin');const r=await fetch('/api/teacher/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin})});if(!r.ok){document.querySelector('#message').textContent='PIN 無效';return}sessionStorage.setItem('teacherPin',pin);location.href='/teacher'};</script></main></body></html>`;

export const teacherPage = `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>老師控制台</title>
<style>:root{color-scheme:dark;--bg:#0b1220;--surface:#151f31;--surface-raised:#1d2a40;--border:#34445d;--text:#edf3fb;--muted:#acbbcf;--primary:#3978e8;--primary-hover:#4b89fa;--success:#36c98a;--success-bg:#103b32;--danger:#f07178;--danger-bg:#48232d;--warning:#f2c66d}*{box-sizing:border-box}[hidden]{display:none!important}body{font:20px/1.6 system-ui,sans-serif;max-width:82rem;margin:2rem auto;padding:0 1.25rem;background:var(--bg);color:var(--text)}main{width:min(100%,72rem);margin-inline:auto}h1{font-size:clamp(2.1rem,4vw,2.8rem);line-height:1.2;margin:0 0 1.5rem}h2{font-size:1.55rem;margin:.2rem 0 1rem}h3{font-size:1.3rem;margin:.8rem 0}section{border:1px solid var(--border);border-radius:1rem;padding:1.3rem 1.5rem;margin:1.2rem 0;background:var(--surface);box-shadow:0 12px 30px #0005}label{display:block;margin:.9rem 0;color:var(--muted)}input,select,textarea,button{font:inherit;padding:.65rem .85rem;border:1px solid var(--border);border-radius:.55rem;background:var(--surface-raised);color:var(--text)}input,select,textarea{max-width:100%}input:focus,select:focus,textarea:focus,button:focus-visible{outline:3px solid #83b2ff;outline-offset:2px}button{cursor:pointer;margin:.25rem;background:#3a4659;border-color:#596b85;font-weight:700}button:hover:not(:disabled){filter:brightness(1.12)}button:disabled{cursor:not-allowed;opacity:.42;filter:grayscale(.7);box-shadow:none}#create,#start,#confirm,#export-confirm-button{background:var(--primary);border-color:var(--primary);color:white}#end{background:#a63245;border-color:#db5669;color:white}#export-preview-button,#export-restore-button,#export-csv-button,#preview{background:#3a4659}#code{display:inline-block;padding:.1rem .6rem;border:1px solid var(--border);border-radius:.6rem;background:#101a2a;color:#b9d3ff;font-size:clamp(2rem,5vw,3rem);line-height:1.2;letter-spacing:.14em}#stage{width:fit-content;margin:.8rem 0;padding:.3rem .85rem;border:1px solid var(--border);border-radius:999px;font-weight:800}.stage-badge{display:inline-flex;align-items:center;width:fit-content;padding:.3rem .85rem;border:1px solid;border-radius:999px;font-size:1.05rem;font-weight:800;letter-spacing:.02em}.stage-preparing{color:#f2c66d;background:#41331b;border-color:#80652c}.stage-buzzing{color:#9fc4ff;background:#183868;border-color:#356bc0}.stage-ended{color:#c4b4ff;background:#30254d;border-color:#66529a}.table-scroll{overflow:auto;border:1px solid var(--border);border-radius:.7rem}table{border-collapse:separate;border-spacing:0;width:100%;min-width:42rem}th,td{border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:.75rem;text-align:left;vertical-align:top}thead th{position:sticky;top:0;z-index:1;background:#24334a;color:#f1f5fb;font-weight:800}tbody th{background:#1b293e;color:#dbe7f7}td{background:#131d2d}tr:last-child>*{border-bottom:0}tr>*:last-child{border-right:0}.winner{background:var(--success-bg);box-shadow:inset 0 0 0 2px #2b9e75}.winner strong{display:inline-block;margin:.15rem 0;padding:.15rem .5rem;border-radius:.4rem;background:#176e52;color:#d6ffed}.cell-status{font-weight:800;color:var(--success)}.muted{color:var(--muted)}#export-preview td:nth-child(4){font-weight:800}#export-preview .status-write{color:#a6f1d0;background:#12372f}#export-preview .status-skip{color:#f2d28c;background:#40351f}#message,#export-state,#export-message{color:#dbe7f7}.description-toggle{display:flex;align-items:center;gap:.8rem;width:fit-content;margin:1rem 0;padding:.7rem 1rem;border:1px solid var(--border);border-radius:.65rem;background:var(--surface-raised);color:var(--text);cursor:pointer}.description-toggle #descriptions{width:1.5rem;height:1.5rem;margin:0;padding:0;flex:0 0 auto;accent-color:var(--primary);cursor:pointer}#import-preview{margin-top:1rem}.import-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.65rem;margin:0 0 1rem}.import-summary>div{padding:.7rem .8rem;border:1px solid var(--border);border-radius:.6rem;background:#101a2a}.import-summary dt{color:var(--muted);font-size:.9rem}.import-summary dd{margin:.1rem 0 0;font-weight:750}.import-warnings{margin:1rem 0;padding:.8rem 1rem;border:1px solid #bd8130;border-radius:.7rem;background:#403019;color:#ffe2a6}.import-warnings h4{margin:0 0 .4rem}.import-warnings ul{margin:.25rem 0;padding-left:1.5rem}.import-table-wrap{overflow:auto;border:1px solid var(--border);border-radius:.7rem}.import-table{width:100%;min-width:60rem;table-layout:fixed}.import-table td.description-cell{width:auto;max-width:none}.description-truncate{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3}.import-raw{margin-top:.8rem;border:1px solid var(--border);border-radius:.6rem;background:#101a2a}.import-raw summary{padding:.7rem 1rem;color:#b9d3ff;font-weight:750;cursor:pointer}.import-raw pre{margin:0;border:0;border-top:1px solid var(--border);border-radius:0;max-height:24rem;overflow:auto}@media(max-width:44rem){body{margin:1rem auto;padding:0 .85rem;font-size:18px}section{padding:1rem}table{min-width:38rem}}</style></head>
<body><main><h1>老師控制台</h1><p id="message" aria-live="polite"></p><section><h2>建立活動</h2><label>題目集 <select id="sets"></select></label><label>組名（每行一組，留白使用預設四組）<textarea id="groups" rows="4"></textarea></label><label>排名規則 <select id="create-ranking-rule"><option value="speed">純速度</option><option value="cap">均分上限</option></select></label><p id="create-ranking-cap" class="muted" hidden></p><button id="create">建立活動</button></section><section><h2>活動控制</h2><p>活動代碼：<strong id="code">—</strong></p><p id="stage" class="stage-badge">尚無活動</p><button id="start">開始搶答</button><button id="end">結束活動</button><label id="activity-ranking-rule-control" hidden>排名規則 <select id="activity-ranking-rule"><option value="speed">純速度</option><option value="cap">均分上限</option></select></label><p id="activity-ranking-rule-readonly" class="muted" hidden></p><label class="description-toggle"><input id="descriptions" type="checkbox">向學生顯示題目敘述</label><h3>即時作答／結果</h3><div id="view" class="table-scroll">尚無活動</div></section><section id="result-export"><h2>結果匯出</h2><p id="export-state">請先建立活動。</p><p>活動資料只存在伺服器記憶體，重啟後消失。</p><button id="export-preview-button" disabled>回寫預覽</button><button id="export-confirm-button" disabled>確認回寫</button><button id="export-restore-button" disabled>還原最近一次回寫</button><button id="export-csv-button" disabled>下載 CSV</button><div id="export-preview" class="table-scroll"></div><p id="export-message" aria-live="polite" style="white-space:pre-line"></p></section><section><h2>匯入題目集</h2><label>Google 試算表網址或 XLSX 路徑 <input id="source" size="55"></label><button id="preview">預覽</button><button id="confirm" disabled>確認匯入</button><div id="import-preview"></div></section></main>
<script src="/socket.io/socket.io.js"></script><script>
const message=document.querySelector('#message'),view=document.querySelector('#view'),code=document.querySelector('#code'),stage=document.querySelector('#stage'),exportState=document.querySelector('#export-state'),exportPreview=document.querySelector('#export-preview'),exportMessage=document.querySelector('#export-message');let previewId='',activeActivityCode='';
function node(tag,text,className){const item=document.createElement(tag);if(text!==undefined)item.textContent=text;if(className)item.className=className;return item}
async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-teacher-pin':sessionStorage.getItem('teacherPin')||''},body:body===undefined?undefined:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||'請求失敗');return data}
function importTime(createdAt){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(createdAt)),part=type=>parts.find(item=>item.type===type)?.value||'';return part('month')+'/'+part('day')+' '+part('hour')+':'+part('minute')}
function renderImportPreview(preview){const container=document.querySelector('#import-preview');container.replaceChildren();const source=preview.importSource==='google'||preview.googleSource?'Google 試算表':'XLSX',summary=node('dl',undefined,'import-summary');for(const [label,value] of [['工作表名稱',preview.sheetName],['來源',source],['總題數',preview.totalQuestionCount],['單題數',preview.singleQuestionCount],['題組數',preview.groupQuestionCount]]){const item=node('div');item.append(node('dt',label),node('dd',String(value)));summary.append(item)}container.append(summary);if(preview.warnings?.length){const warnings=node('div',undefined,'import-warnings');warnings.append(node('h4','解析警告'));const list=node('ul');for(const warning of preview.warnings){const location=warning.cell?warning.cell.sheetName+'!'+warning.cell.address+'：':'';list.append(node('li',location+warning.message))}warnings.append(list);container.append(warnings)}const wrap=node('div',undefined,'import-table-wrap'),table=node('table',undefined,'import-table'),columns=node('colgroup');for(const width of ['8%','11%','10%','12%','12%']){const col=document.createElement('col');col.style.width=width;columns.append(col)}table.append(columns);const head=node('thead'),header=node('tr');for(const title of ['題號','類型','小題','標籤格','作答格','題目敘述'])header.append(node('th',title));head.append(header);table.append(head);const body=node('tbody');for(const question of preview.questions){for(const subquestion of question.subquestions){const row=node('tr'),description=node('td',question.description,'description-cell');description.classList.add('description-truncate');row.append(node('td','第 '+question.number+' 題'),node('td',question.type==='single'?'單題':'題組'),node('td','小題 '+subquestion.number),node('td',subquestion.labelCell?.address||'—'),node('td',subquestion.answerCell.address),description);body.append(row)}}table.append(body);wrap.append(table);container.append(wrap);const details=document.createElement('details');details.className='import-raw';details.append(node('summary','原始資料'),node('pre',JSON.stringify(preview,null,2)));container.append(details)}
async function refreshSets(){
  const data=await api('/api/teacher/question-sets'),select=document.querySelector('#sets');select.replaceChildren();
  for(const item of data.items){
    const source=item.source==='google'?'Google 試算表':item.source==='xlsx'?'XLSX':'舊版匯入（無來源資訊）';
    const option=new Option(item.sheetName+'（'+item.totalQuestionCount+' 題）｜'+source+'｜'+importTime(item.createdAt),item.id);
    option.dataset.totalQuestionCount=String(item.totalQuestionCount);select.add(option);
  }
  if(select.options.length)select.selectedIndex=0;
  updateCreateRankingCap();
}function renderTable(data){
  view.replaceChildren();
  if(!data){view.textContent='尚無活動';return}
  const table=node('table'),head=node('thead'),header=node('tr');
  header.append(node('th','題號／小題'));
  for(const group of data.groups)header.append(node('th',group.name+'（線上頁面：'+group.onlineStudentPages+'）'));
  head.append(header);table.append(head);
  const body=node('tbody');
  for(const question of data.questions){
    for(let index=0;index<question.subquestions.length;index++){
      const subquestion=question.subquestions[index],row=node('tr');
      const label=question.subquestions.length===1?'第 '+question.number+' 題':'第 '+question.number+' 題・小題 '+subquestion.number;
      const heading=node('th');heading.append(node('div',label));
      if(index===0&&question.explanation)heading.append(node('div',question.explanation,'muted result-explanation'));
      row.append(heading);
      for(const group of question.groups){
        const cell=node('td');
        if(group.submitted){
          cell.append(node('div','已送出','cell-status'),node('div','原始順位：'+group.originalRank));
          if(group.skipped)cell.append(node('div','已達上限（跳過）'),node('div',group.explanation,'muted'));
          else{
            cell.append(node('div','最終順位：'+group.finalRank));
            if(group.explanation)cell.append(node('div',group.explanation,'muted'));
          }
          const answer=group.answers&&group.answers.find(item=>item.subquestionNumber===subquestion.number);
          if(answer)cell.append(node('div','答案：'+answer.answer));
          if(group.successful){cell.className='winner';cell.append(node('strong','本題成功組'))}
        }else cell.append(node('div','尚未送出','muted'));
        row.append(cell);
      }
      body.append(row);
    }
  }
  table.append(body);view.append(table);
}function updateExportControls(data){const ended=!!data&&data.stage==='ended',canWrite=ended&&data.canWriteSpreadsheet===true;document.querySelector('#export-preview-button').disabled=!canWrite;document.querySelector('#export-confirm-button').disabled=!canWrite||!previewId;document.querySelector('#export-restore-button').disabled=!canWrite;document.querySelector('#export-csv-button').disabled=!ended;const noSource=data&&data.questionSetSource!=='google',sourceReason=data?.questionSetSource==='xlsx'?'題目集來源為 XLSX，無法回寫或還原試算表；CSV 仍可下載。':data?.questionSetSource==='legacy'?'此題目集匯入時未記錄試算表來源，請重新匯入 Google 試算表後再建立活動。':'題目集沒有 Google 試算表來源，無法回寫或還原；CSV 仍可下載。';exportState.textContent=!data?'請先建立活動。':!ended?'請先結束活動。':noSource?sourceReason:'活動已結束，可預覽回寫或匯出 CSV。'}
function renderExportPreview(preview){exportPreview.replaceChildren();const table=node('table'),head=node('thead'),header=node('tr');for(const title of ['A1','目前內容','預計值','狀態'])header.append(node('th',title));head.append(header);table.append(head);const body=node('tbody');for(const target of preview.targets){const row=node('tr'),statusClass=target.status==='將寫入'?'status-write':'status-skip';row.append(node('td',target.cell.sheetName+'!'+target.cell.address),node('td',target.currentValue===null?'':String(target.currentValue)),node('td',target.answer),node('td',target.status,statusClass));body.append(row)}table.append(body);exportPreview.append(table)}
function rankingRuleText(rule){return '排名規則：'+rule.name+(rule.explanation?'（'+rule.explanation+'）':'')}
function show(response){
  const data=response.activity||response;
  if(!data||!data.activityCode){renderTable(null);updateExportControls(null);return}
  if(activeActivityCode!==data.activityCode){previewId='';exportPreview.replaceChildren();exportMessage.textContent='';activeActivityCode=data.activityCode}
  code.textContent=data.activityCode;
  stage.textContent='目前階段：'+({preparing:'準備中',buzzing:'搶答中',ended:'已結束'}[data.stage]||data.stage);
  stage.className='stage-badge stage-'+data.stage;
  document.querySelector('#descriptions').checked=data.questionDescriptionsVisible;
  const ruleControl=document.querySelector('#activity-ranking-rule-control'),ruleReadonly=document.querySelector('#activity-ranking-rule-readonly'),ruleSelect=document.querySelector('#activity-ranking-rule');
  if(data.rankingRule){
    ruleSelect.value=data.rankingRule.name==='均分上限'?'cap':'speed';
    ruleReadonly.textContent=rankingRuleText(data.rankingRule);
  }
  ruleControl.hidden=data.stage!=='preparing';ruleReadonly.hidden=data.stage==='preparing';
  ruleSelect.disabled=data.stage!=='preparing';
  renderTable(data);updateExportControls(data);
}
function updateCreateRankingCap(){
  const rule=document.querySelector('#create-ranking-rule').value,capText=document.querySelector('#create-ranking-cap');
  if(rule!=='cap'){capText.hidden=true;capText.textContent='';return}
  const option=document.querySelector('#sets').selectedOptions[0],questionCount=Number(option?.dataset.totalQuestionCount||0);
  const names=document.querySelector('#groups').value.split(/\\r?\\n/).map(value=>value.trim()).filter(Boolean),groupCount=names.length||4;
  capText.textContent='每組最多成功 '+Math.ceil(questionCount/groupCount)+' 題';capText.hidden=false;
}
const socket=io({auth:{role:'teacher',pin:sessionStorage.getItem('teacherPin')||''},reconnection:true});
socket.on('activity:teacher-view',show);
socket.on('connect_error',()=>message.textContent='即時連線失敗，請重新登入。');
document.querySelector('#create-ranking-rule').onchange=updateCreateRankingCap;
document.querySelector('#sets').onchange=updateCreateRankingCap;
document.querySelector('#groups').oninput=updateCreateRankingCap;
document.querySelector('#activity-ranking-rule').onchange=async event=>{try{show(await api('/api/teacher/ranking-rule',{rankingRule:event.target.value}))}catch(error){message.textContent=error.message;api('/api/teacher/view').then(show).catch(()=>{})}};
document.querySelector('#create').onclick=async()=>{try{const names=document.querySelector('#groups').value.split(/\\r?\\n/).map(value=>value.trim()).filter(Boolean);show(await api('/api/teacher/activity',{questionSetId:document.querySelector('#sets').value,rankingRule:document.querySelector('#create-ranking-rule').value,...(names.length?{groupNames:names}:{})}));message.textContent='活動已建立'}catch(error){message.textContent=error.message}};document.querySelector('#start').onclick=async()=>{try{show(await api('/api/teacher/start',{}))}catch(error){message.textContent=error.message}};document.querySelector('#end').onclick=async()=>{try{show(await api('/api/teacher/end',{}))}catch(error){message.textContent=error.message}};
document.querySelector('#descriptions').onchange=async event=>{try{show(await api('/api/teacher/descriptions',{visible:event.target.checked}))}catch(error){message.textContent=error.message}};
document.querySelector('#preview').onclick=async()=>{const input=document.querySelector('#source').value.trim();if(!input){message.textContent='請輸入網址';return}try{const data=await api('/api/teacher/import/preview',{input});previewId=data.preview.id;renderImportPreview(data.preview);document.querySelector('#confirm').disabled=false;message.textContent='預覽完成'}catch(error){message.textContent=error.message}};
document.querySelector('#confirm').onclick=async()=>{try{const data=await api('/api/teacher/import/confirm',{previewId});document.querySelector('#import-preview').textContent='已建立題目集：'+data.questionSet.id;document.querySelector('#confirm').disabled=true;await refreshSets()}catch(error){message.textContent=error.message}};
document.querySelector('#export-preview-button').onclick=async()=>{try{const data=await api('/api/teacher/export/preview',{});previewId=data.preview.id;renderExportPreview(data.preview);updateExportControls({activityCode:activeActivityCode,stage:'ended',canWriteSpreadsheet:true,questionSetSource:'google'});exportMessage.textContent='回寫預覽完成，請檢查各格後確認。'}catch(error){exportMessage.textContent=error.message}};
document.querySelector('#export-confirm-button').onclick=async()=>{try{const data=await api('/api/teacher/export/confirm',{previewId});previewId='';updateExportControls({activityCode:activeActivityCode,stage:'ended',canWriteSpreadsheet:true,questionSetSource:'google'});exportMessage.textContent=data.backupPath?'回寫成功（'+data.updatedCells+' 格）。備份檔：'+data.backupPath:'沒有需要寫入的格子。'}catch(error){previewId='';updateExportControls({activityCode:activeActivityCode,stage:'ended',canWriteSpreadsheet:true,questionSetSource:'google'});exportMessage.textContent=error.message}};
document.querySelector('#export-restore-button').onclick=async()=>{try{const data=await api('/api/teacher/export/restore',{});const lines=[];if(data.message)lines.push(data.message);for(const cell of data.restored)lines.push('已還原：'+cell.address);for(const cell of data.skipped)lines.push('已跳過：'+cell.address+'（'+cell.reason+'）');for(const cell of data.failed||[])lines.push('還原失敗：'+cell.address+'（'+cell.reason+'；目前值：'+String(cell.actualValue)+'；原值：'+String(cell.expectedValue)+'）');exportMessage.textContent=lines.join('\\n')}catch(error){exportMessage.textContent=error.message}};
document.querySelector('#export-csv-button').onclick=async()=>{try{const response=await fetch('/api/teacher/export/csv',{headers:{'x-teacher-pin':sessionStorage.getItem('teacherPin')||''}});if(!response.ok){let detail={};try{detail=await response.json()}catch{}throw Error(detail.error||'CSV 下載失敗')}const blob=await response.blob(),objectUrl=URL.createObjectURL(blob),link=document.createElement('a');link.href=objectUrl;link.download='results-'+code.textContent+'.csv';document.body.append(link);link.click();link.remove();URL.revokeObjectURL(objectUrl);exportMessage.textContent='CSV 已下載。'}catch(error){exportMessage.textContent=error.message}};
refreshSets().then(()=>api('/api/teacher/view')).then(show).catch(error=>message.textContent=error.message);
</script></body></html>`;
