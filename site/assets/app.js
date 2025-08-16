(function(){
  const qs=(id)=>document.getElementById(id);
  const targetLangSel=qs('lang'); const htmlFile=qs('htmlFile');
  const fileBtn=qs('fileBtn'); const fileName=qs('fileName');
  const filename=qs('filename'); const chooseLocation=qs('chooseLocation');
  const btnTranslate=qs('btnTranslate'); const btnDownload=qs('btnDownload');
  const progressEl=qs('progress'); const progressPct=qs('progressPct');
  const output=qs('output'); const msgOk=qs('msgOk'); const msgErr=qs('msgErr');
  const uiLangSel=qs('uiLang'); const PROXY_URL=window.PROXY_URL||'http://localhost:8787/translate';
  let latestTranslatedHTML='';
  function showErr(m){msgErr.textContent=m;msgErr.style.display='block';msgOk.style.display='none'}
  function showOk(m){msgOk.textContent=m;msgOk.style.display='block';msgErr.style.display='none'}
  function clearMsgs(){msgErr.style.display='none';msgOk.style.display='none'}
  function setBusy(b){btnTranslate.disabled=b;btnDownload.disabled=b||!latestTranslatedHTML;progressEl.style.display=b?'block':'none'}
  function getTextNodes(doc){const w=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT,{acceptNode(n){if(n.parentNode&&['SCRIPT','STYLE'].includes(n.parentNode.tagName))return NodeFilter.FILTER_REJECT;return n.nodeValue&&n.nodeValue.trim()?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP;}});const nodes=[];let n;while((n=w.nextNode()))nodes.push(n);return nodes}
  function chunk(a,s){const o=[];for(let i=0;i<a.length;i+=s)o.push(a.slice(i,i+s));return o}
  async function translateViaProxy(texts,targetLang){const r=await axios.post(PROXY_URL,{texts,targetLang});if(!r.data||!Array.isArray(r.data.translations))throw new Error('Proxy returned an invalid response.');return r.data.translations}
  async function translateHTML(){clearMsgs();setBusy(true);progressPct.textContent='0%';try{const file=htmlFile.files[0];if(!file)throw new Error(window.I18N.errNoFile);const target=targetLangSel.value;const text=await file.text();const parser=new DOMParser();const doc=parser.parseFromString(text,'text/html');const nodes=getTextNodes(doc);if(!nodes.length)throw new Error(window.I18N.errNoText);const originals=nodes.map(n=>n.nodeValue);const BATCH=50;const batches=chunk(originals,BATCH);let done=0;for(let b=0;b<batches.length;b++){const translated=await translateViaProxy(batches[b],target);for(let i=0;i<translated.length;i++){const idx=b*BATCH+i;if(nodes[idx])nodes[idx].nodeValue=translated[i]}done+=batches[b].length;progressPct.textContent=Math.round(100*done/originals.length)+'%'}const serializer=new XMLSerializer();latestTranslatedHTML=serializer.serializeToString(doc);output.value=latestTranslatedHTML;btnDownload.disabled=false;showOk(window.I18N.okDone)}catch(err){console.error(err);showErr((window.I18N.errTranslate||'Error: ')+(err.response?.data?.error||err.message||'Unknown error'))}finally{setBusy(false)}}
  function sanitizeFilename(name){name=(name||'').trim();if(!name)return'translated.html';name=name.replace(/[\\/:*?\"<>|\\x00-\\x1F]/g,'_');if(!/\\.html?$/i.test(name))name+='.html';return name}
  async function downloadTranslated(){if(!latestTranslatedHTML){showErr(window.I18N.errNoOutput);return}const filenameVal=sanitizeFilename(filename.value);if(chooseLocation.checked&&window.showSaveFilePicker){try{const handle=await window.showSaveFilePicker({suggestedName:filenameVal,types:[{description:'HTML Files',accept:{'text/html':['.html','.htm']}}]});const w=await handle.createWritable();await w.write(new Blob([latestTranslatedHTML],{type:'text/html'}));await w.close();showOk(window.I18N.okSaved);return}catch(e){if(e&&e.name==='AbortError'){showErr(window.I18N.errSaveCanceled);return}console.error(e)}}const blob=new Blob([latestTranslatedHTML],{type:'text/html'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filenameVal;a.click();URL.revokeObjectURL(a.href);showOk(window.I18N.okDlStarted)}
  uiLangSel.addEventListener('change',()=>{const lang=uiLangSel.value.toLowerCase();window.location.href=`/app/${lang}/`});
  document.getElementById('btnTranslate').addEventListener('click',translateHTML);
  document.getElementById('btnDownload').addEventListener('click',downloadTranslated);
  document.getElementById('fileBtn').addEventListener('click',()=>htmlFile.click());
  document.getElementById('fileBtn').addEventListener('keydown',(e)=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();htmlFile.click();}});
  htmlFile.addEventListener('change',()=>{document.getElementById('fileName').textContent=htmlFile.files?.[0]?.name||window.I18N.noFile});
  (function(){const current=document.documentElement.lang?.toUpperCase()||'EN';const sel=document.getElementById('uiLang');if(sel)sel.value=current})();
})();