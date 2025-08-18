// assets/app.js
(function () {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const uiLangSel      = $("uiLang");
  const targetLangSel  = $("lang");
  const htmlFile       = $("htmlFile");
  const fileBtn        = $("fileBtn");
  const fileName       = $("fileName");
  const filenameInput  = $("filename");
  const chooseLocation = $("chooseLocation");
  const btnTranslate   = $("btnTranslate");
  const btnDownload    = $("btnDownload");
  const progressEl     = $("progress");
  const progressPct    = $("progressPct");
  const output         = $("output");
  const msgOk          = $("msgOk");
  const msgErr         = $("msgErr");

  // ---------- Config ----------
  const PROXY_URL = "/api/translate";   // via nginx (same-origin)
  const MAX_CHUNK_CHARS = 48000;
  const MIN_TEXT_LEN = 1;
  let latestTranslatedHTML = "";

  // ---------- I18N (optioneel) ----------
  (async () => {
    try {
      const pageLang = (document.documentElement.lang || "").split("-")[0].toLowerCase() || "en";
      const r = await fetch(`/assets/i18n/${pageLang}.json`, { cache: "no-store" });
      if (r.ok) window.I18N = await r.json();
    } catch {}
  })();

  // ---------- Helpers ----------
  const normalize = (s) =>
    (s || "")
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");

  const LANG_NAME2CODE = (() => {
    const map = new Map();
    // EN
    ["en","eng","english","engels","anglais","inglese","inglés","ingles"].forEach(k=>map.set(k,"en"));
    // NL
    ["nl","dut","dutch","nederlands","neerlandais","hollands"].forEach(k=>map.set(k,"nl"));
    // DE
    ["de","ger","deu","german","deutsch","allemand","aleman"].forEach(k=>map.set(k,"de"));
    // FR
    ["fr","fre","fra","french","français","frans","francais"].forEach(k=>map.set(k,"fr"));
    // IT
    ["it","ita","italian","italiano","italiaans"].forEach(k=>map.set(k,"it"));
    // ES
    ["es","spa","spanish","español","espanol","spaans"].forEach(k=>map.set(k,"es"));
    // PT
    ["pt","por","portuguese","português","portugues","portugees"].forEach(k=>map.set(k,"pt"));
    return map;
  })();

  function getLangFromUrl() {
    const m = location.pathname.match(/\/app\/([a-z]{2})(?:\/|$)/i);
    return m ? m[1].toLowerCase() : null;
  }

  function isLangUrl(v) {
    return typeof v === "string" && /^\/app\/[a-z]{2}\/$/i.test(v.trim());
  }

  // Kies optie in <select> die bij de huidige URL past
  function syncSelectToCurrent(selectEl) {
    if (!selectEl) return;
    const code = getLangFromUrl() || (document.documentElement.lang || "en").slice(0,2).toLowerCase();
    const wantUrl = `/app/${code}/`;
    const opts = Array.from(selectEl.options || []);

    // 1) Directe URL-match (variant A)
    let opt = opts.find(o => isLangUrl(o.value) && o.value.toLowerCase() === wantUrl);
    if (!opt) {
      // 2) value == code (en/EN) of tekst -> code (variant B)
      opt =
        opts.find(o => normalize(o.value) === code) ||
        opts.find(o => normalize(o.value) === code.toUpperCase()) ||
        opts.find(o => LANG_NAME2CODE.get(normalize(o.textContent)) === code);
    }
    if (!opt) {
      // 3) fallback: als opties een data-code hebben
      opt = opts.find(o => normalize(o.getAttribute("data-code")) === code);
    }
    if (opt) selectEl.value = opt.value;
  }

  // Bepaal redirect-URL op basis van de geselecteerde optie (werkt voor A en B)
  function urlFromSelectedOption(selectEl) {
    const opt =
      selectEl?.selectedOptions?.[0] ||
      (selectEl ? selectEl.options[selectEl.selectedIndex] : null);
    if (!opt) return null;

    // A) Als value al een URL is → die gebruiken
    const val = String(opt.value || "");
    if (isLangUrl(val)) return val;

    // B) Value/tekst/data-code naar 2-letter code mappen
    const v = normalize(val);
    const t = normalize(opt.textContent);
    const d = normalize(opt.getAttribute("data-code"));
    let code =
      LANG_NAME2CODE.get(v) ||
      LANG_NAME2CODE.get(t) ||
      LANG_NAME2CODE.get(d);

    if (!code) {
      const mVal = v.match(/^[a-z]{2}$/i);
      const mTxt = t.match(/^[a-z]{2}$/i);
      code = (mVal?.[0] || mTxt?.[0] || "en").toLowerCase();
    }
    return `/app/${code}/`;
  }

  function showErr(m){ if(msgErr&&msgOk){ msgErr.textContent=String(m||""); msgErr.style.display="block"; msgOk.style.display="none"; } }
  function showOk(m){ if(msgErr&&msgOk){ msgOk.textContent=String(m||""); msgOk.style.display="block"; msgErr.style.display="none"; } }
  function clearMsgs(){ if(msgErr) msgErr.style.display="none"; if(msgOk) msgOk.style.display="none"; }
  function setBusy(b){ if(btnTranslate) btnTranslate.disabled=!!b; if(btnDownload) btnDownload.disabled=!!b||!latestTranslatedHTML; if(progressEl) progressEl.style.display=b?"block":"none"; }
  function setProgress(pct,text){ if(progressPct) progressPct.textContent=`${Math.round(pct)}%${text?` • ${text}`:""}`; }

  // ---------- HTML parsing ----------
  function isTranslatableTextNode(node){
    if(!node||node.nodeType!==Node.TEXT_NODE) return false;
    if(!node.nodeValue||!node.nodeValue.trim()) return false;
    const forbidden=new Set(["SCRIPT","STYLE","NOSCRIPT"]);
    let p=node.parentNode;
    while(p&&p.nodeType===Node.ELEMENT_NODE){ if(forbidden.has(p.nodeName)) return false; p=p.parentNode; }
    return true;
  }
  function getTextNodes(doc){
    const w=doc.createTreeWalker(doc.body,NodeFilter.SHOW_TEXT,null,false);
    const nodes=[]; let n; while((n=w.nextNode())){ if(isTranslatableTextNode(n)) nodes.push(n); } return nodes;
  }
  function chunkByChars(items,maxChars){
    const chunks=[]; let buf=[]; let count=0;
    for(const s of items){ const len=s.length;
      if(buf.length && count+len>maxChars){ chunks.push(buf); buf=[s]; count=len; }
      else{ buf.push(s); count+=len; } }
    if(buf.length) chunks.push(buf); return chunks;
  }

  // ---------- Network ----------
  async function translateViaProxy(texts,targetLang){
    const resp = await fetch(PROXY_URL, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ texts, targetLang })
    });
    if(!resp.ok){
      const ra=resp.headers.get("Retry-After"); const body=await resp.text().catch(()=> "");
      throw new Error(`Proxy ${resp.status}${ra?` (Retry-After: ${ra}s)`:""}${body?` - ${body}`:""}`);
    }
    const data = await resp.json();
    if(!data || !Array.isArray(data.translations)) throw new Error("Proxy returned an invalid response.");
    return data.translations;
  }

  // ---------- Translate flow ----------
  async function translateHTML(){
    clearMsgs(); setBusy(true); setProgress(0, window.I18N?.starting || "Starten…");
    try{
      const file = htmlFile?.files?.[0];
      if(!file){ showErr(window.I18N?.noFile || "Geen HTML-bestand gekozen."); return; }
      const targetLang = String(targetLangSel?.value || "").toUpperCase();
      if(!targetLang){ showErr(window.I18N?.noTarget || "Kies een doeltaal."); return; }

      const text = await file.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, "text/html");

      const nodes = getTextNodes(doc);
      const originals = nodes.map(n=>n.nodeValue);

      const idx=[], texts=[];
      for(let i=0;i<originals.length;i++){
        const s=originals[i]||"";
        if(s.trim().length>=MIN_TEXT_LEN){ idx.push(i); texts.push(s); }
      }
      if(!texts.length){ showErr(window.I18N?.noTranslatable || "Geen vertaalbare tekst gevonden."); return; }

      const chunks = chunkByChars(texts, MAX_CHUNK_CHARS);
      const outAll=[];
      for(let i=0;i<chunks.length;i++){
        setProgress((i/chunks.length)*100, `${i+1}/${chunks.length}`);
        const out = await translateViaProxy(chunks[i], targetLang);
        if(!out || out.length!==chunks[i].length) throw new Error("Vertaalserver gaf een mismatch in aantallen terug.");
        outAll.push(...out);
      }

      setProgress(100, window.I18N?.applying || "Resultaat toepassen…");
      for(let k=0;k<idx.length;k++){ nodes[idx[k]].nodeValue = outAll[k]; }

      const finalHTML = "<!doctype html>\n"+doc.documentElement.outerHTML;
      latestTranslatedHTML = finalHTML;
      if(output) output.value = finalHTML;
      showOk(window.I18N?.okTranslated || "Vertaling gereed.");
      if(btnDownload) btnDownload.disabled = false;
    }catch(err){
      console.error(err);
      showErr(`${window.I18N?.translateFailed || "Vertalen mislukt"}: ${err?.message || "Unknown error"}`);
    }finally{
      setBusy(false); setProgress(0,"");
    }
  }

  // ---------- Download ----------
  function sanitizeFilename(name){
    name=(name||"").trim(); if(!name) name="translated.html";
    name=name.replace(/[\\/:*?"<>|#\u0000-\u001F]/g,"_");
    if(!/\.html?$/i.test(name)) name+=".html";
    return name;
  }
  async function downloadTranslated(){
    if(!latestTranslatedHTML) return;
    const suggestedName = sanitizeFilename(filenameInput?.value || "translated.html");

    if(chooseLocation?.checked && "showSaveFilePicker" in window){
      try{
        const handle=await window.showSaveFilePicker({
          suggestedName,
          types:[{ description:"HTML", accept:{ "text/html":[".html",".htm"] } }]
        });
        const w=await handle.createWritable();
        await w.write(new Blob([latestTranslatedHTML],{type:"text/html;charset=utf-8"}));
        await w.close();
        showOk(window.I18N?.okSaved || "Bestand opgeslagen."); return;
      }catch(e){ if(e?.name!=="AbortError") console.warn("SaveFilePicker error:",e); }
    }

    const blob=new Blob([latestTranslatedHTML],{type:"text/html;charset=utf-8"});
    const a=document.createElement("a");
    a.href=URL.createObjectURL(blob); a.download=suggestedName;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(a.href);
    showOk(window.I18N?.okDlStarted || "Download gestart.");
  }

  // ---------- Init ----------
  function wireLanguageSelect() {
    if (!uiLangSel) return;

    // Sync naar huidige URL
    syncSelectToCurrent(uiLangSel);

    // Redirect bij wijziging: gebruik URL-value als die er is, anders code→URL
    function onPick() {
      const url = urlFromSelectedOption(uiLangSel);
      if (!url) return;
      if (location.pathname.toLowerCase() === url.toLowerCase()) {
        // forceer reload als dezelfde pagina is gekozen
        location.reload();
      } else {
        location.href = url;
      }
    }
    uiLangSel.addEventListener("change", onPick);
    uiLangSel.addEventListener("input", onPick); // sommige UI’s vuren alleen 'input'
  }

  // Script kan onderaan body staan (DOM is klaar). Voor de zekerheid fallback:
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireLanguageSelect, { once: true });
  } else {
    wireLanguageSelect();
  }

  // Overige handlers
  function bootRest(){
    if (fileBtn && htmlFile) {
      fileBtn.addEventListener("click", () => htmlFile.click());
      fileBtn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); htmlFile.click(); }
      });
    }
    if (htmlFile && fileName) {
      htmlFile.addEventListener("change", () => {
        fileName.textContent = htmlFile.files?.[0]?.name || (window.I18N?.noFile ?? "Geen bestand gekozen");
      });
    }
    if (btnTranslate) btnTranslate.addEventListener("click", translateHTML);
    if (btnDownload)  btnDownload.addEventListener("click", downloadTranslated);
    if (progressEl)   progressEl.style.display = "none";
    if (btnDownload)  btnDownload.disabled = !latestTranslatedHTML;
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootRest, { once: true });
  } else {
    bootRest();
  }
})();
