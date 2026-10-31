'use strict';
const $ = id => document.getElementById(id);
const audio = $('audio');
let radio = {}, scan = {active:false}, library = {multiplexes:[]}, channels = [], gain = {}, busy = false;
let wantedAudio = false, serviceSignature = '', librarySignature = '', slideKey = '', toastTimer, lastLibraryLoad = 0;
let remoteScanSeen = false, recoveryPending = false;
let interruptedPlayback=false, interruptionResumeBusy=false, interruptionAttempts=0;
let networkRetryTimer=null,networkRetryCount=0,networkRetryGeneration=0,networkRecovering=false;
let stationLogos = {}, lastLogoLoad = 0;
let artworkRetryAt = 0;
let favorites=[];
try{const saved=JSON.parse(localStorage.getItem('dab-favorites-v1')||'[]');if(Array.isArray(saved))favorites=saved.filter(s=>s&&typeof s.sid==='string'&&Number.isInteger(s.frequencyKHz)&&typeof s.label==='string');}catch{}
let favoriteSignature='';
let mosaicSignature='', mosaicExpanded=false, mosaicNativeFullscreen=false;
let manualHistory=[],manualFrequency=null,manualStationsSignature='',manualDetailFrequency=null;
function renderManual(){
 const active=radio.frequencyKHz,stamp=Date.now();
 if(manualFrequency!==active||scan.active){manualFrequency=active;manualHistory=[];}
 if(!scan.active&&typeof radio.snr==='number'&&Number.isFinite(radio.snr)&&(!manualHistory.length||stamp-manualHistory.at(-1).t>=800))manualHistory.push({t:stamp,v:radio.snr});
 manualHistory=manualHistory.filter(p=>stamp-p.t<=120000);
 text('manualNow',radio.channel?'Canal '+radio.channel:'Aucun canal');
 text('manualMux',!scan.active&&radio.syncLevel===2&&radio.ensemble?.valid?radio.ensemble.label:'En attente d’un multiplex');
 text('manualSnr',scan.active?'Scan en cours':number(radio.snr,' dB'));
 text('manualReception',scan.active?'Le scan utilise le récepteur.':radio.syncLevel===2?'Réception synchronisée':'Recherche du signal');
 const ceiling=Math.max(20,Math.ceil(Math.max(0,...manualHistory.map(p=>p.v))/10)*10);text('snrAxisMax',ceiling);text('snrAxisMid',ceiling/2);
 const points=manualHistory.map(p=>[36+(1-(stamp-p.t)/120000)*554,116-Math.max(0,Math.min(ceiling,p.v))*104/ceiling]);
 $('snrLine').setAttribute('points',points.map(p=>p.join(',')).join(' '));$('snrPoint').toggleAttribute('hidden',!points.length);
 if(points.length){$('snrPoint').setAttribute('cx',points.at(-1)[0]);$('snrPoint').setAttribute('cy',points.at(-1)[1]);}
 for(const tile of $('manualChannels').children){
  const frequency=Number(tile.dataset.frequency),live=frequency===active&&!scan.active;
  const saved=library.multiplexes.filter(m=>m.frequencyKHz===frequency).sort((a,b)=>b.lastSeen.localeCompare(a.lastSeen))[0];
  const received=live?radio.syncLevel===2&&radio.ensemble?.valid:!!saved;
  const snr=live?radio.snr:saved?.snr;
  tile.classList.toggle('selected',live);tile.classList.toggle('received',!!received);
  tile.classList.toggle('inspected',frequency===manualDetailFrequency);
  tile.setAttribute('aria-expanded',String(frequency===manualDetailFrequency));
  tile.style.setProperty('--bar-height',Math.max(4,Math.min(100,(Number(snr)||0)/30*100))+'%');
  tile.querySelector('.bar-value').textContent=typeof snr==='number'?number(snr,''): '\u2014';
  tile.setAttribute('aria-label',tile.dataset.channel+' : '+(received?(live?radio.ensemble.label:saved.label):'Pas de multiplex re\u00e7u')+', SNR '+number(snr,' dB')+(live?' en direct':' m\u00e9moris\u00e9')+'. Afficher les informations');

 }
 renderManualDetails();
 const sig=JSON.stringify([active,scan.active,radio.services,stationLogos]);
 if(sig!==manualStationsSignature){manualStationsSignature=sig;$('manualStations').replaceChildren(...(scan.active?[]:radio.services||[]).map(s=>stationButton(s,active)));}
}
const favoriteKey=(s,f)=>Number(s.sid)+':'+Number(s.scids||0);
let favoritesBusy=false,lastFavoritesLoad=0;
function applyFavorites(result){favorites=result.favorites;renderFavorites();updateFavoriteStars();lastFavoritesLoad=Date.now();}
async function loadFavorites(){
 if(favoritesBusy)return;
 favoritesBusy=true;
 try{
  let legacy=[];
  try{legacy=JSON.parse(localStorage.getItem('dab-favorites-v1')||'[]');}catch{}
  const migrate=Array.isArray(legacy)&&legacy.length>0;
  const result=await api('/favorites',migrate?{action:'merge',favorites:legacy}:undefined);
  if(!Array.isArray(result.favorites))throw new Error('Serveur des favoris indisponible');
  if(migrate){try{localStorage.removeItem('dab-favorites-v1');}catch{}}
  applyFavorites(result);
 }finally{favoritesBusy=false;}
}
async function toggleFavorite(station,frequency){
 if(favoritesBusy)return;
 favoritesBusy=true;
 const matches=favorites.filter(s=>favoriteKey(s,s.frequencyKHz)===favoriteKey(station,frequency));
 const found=matches.length>0;
 try{
  if(found){for(const saved of matches)applyFavorites(await api('/favorites',{action:'remove',station:saved}));}
  else applyFavorites(await api('/favorites',{action:'add',station:{...station,frequencyKHz:frequency}}));
  toast(found?'Station retirée des favoris.':'Station ajoutée aux favoris partagés.');
 }catch(e){toast('Favoris non enregistrés : '+e.message);}
 finally{favoritesBusy=false;}
}
function updateFavoriteStars(){
 const keys=new Set(favorites.map(s=>favoriteKey(s,s.frequencyKHz)));
 document.querySelectorAll('.favorite-star').forEach(b=>{const selected=keys.has(b.dataset.key);b.textContent=selected?'★':'☆';b.setAttribute('aria-pressed',String(selected));b.setAttribute('aria-label',(selected?'Retirer des favoris : ':'Ajouter aux favoris : ')+b.dataset.label);});
}
async function chooseFavoriteChannel(station,frequency){
 if(favoritesBusy||busy||scan.active)return;
 favoritesBusy=true;updateControls();
 try{
  const previous=favorites.filter(s=>favoriteKey(s)===favoriteKey(station)&&s.frequencyKHz!==frequency);
  let result=await api('/favorites',{action:'add',station:{...station,frequencyKHz:frequency}});
  for(const saved of previous)result=await api('/favorites',{action:'remove',station:saved});
  applyFavorites(result);
  toast('Canal enregistré. Appuie sur la station pour écouter.');
 }catch(e){toast('Canal non enregistr\u00e9 : '+e.message);}
 finally{favoritesBusy=false;favoriteSignature='';renderFavorites();updateControls();}
}
function orderedFavorites(){return [...new Map(favorites.map(s=>[favoriteKey(s),s])).values()].sort((a,b)=>a.label.localeCompare(b.label,'fr',{sensitivity:'base',numeric:true})||favoriteKey(a).localeCompare(favoriteKey(b)));}
function renderFavorites(){
 const signature=JSON.stringify([favorites,stationLogos,library.multiplexes]);if(signature===favoriteSignature)return;favoriteSignature=signature;
 const unique=orderedFavorites();
 $('favoriteStations').replaceChildren(...unique.map(s=>{
  const row=stationButton(s,s.frequencyKHz);
  const muxNames=[...new Set(library.multiplexes.filter(m=>Number(m.frequencyKHz)===Number(s.frequencyKHz)&&m.services.some(other=>favoriteKey(other)===favoriteKey(s))).map(m=>m.label).filter(Boolean))];
  const subtitle=row.querySelector('.station-copy small');
  subtitle.textContent=muxNames.length?muxNames.join(' / '):'Multiplex non renseign\u00e9';
  subtitle.title=subtitle.textContent;
  const choices=new Map([[s.frequencyKHz,channels.find(c=>c.frequencyKHz===s.frequencyKHz)?.channel||String(s.frequencyKHz/1000)+' MHz']]);
  for(const mux of library.multiplexes){if(mux.services.some(other=>favoriteKey(other)===favoriteKey(s)))choices.set(mux.frequencyKHz,mux.channel);}
  for(const other of favorites){if(favoriteKey(other)===favoriteKey(s)&&!choices.has(other.frequencyKHz))choices.set(other.frequencyKHz,channels.find(c=>c.frequencyKHz===other.frequencyKHz)?.channel||String(other.frequencyKHz/1000)+' MHz');}
  const select=element('select','favorite-channel');select.setAttribute('aria-label','Canal de '+s.label);select.title='Canaux m\u00e9moris\u00e9s pour cette radio';
  for(const [frequency,channel] of [...choices].sort((a,b)=>a[0]-b[0])){const option=element('option','','Canal '+channel);option.value=frequency;select.append(option);}
  select.value=s.frequencyKHz;select.disabled=choices.size<2||busy||scan.active||favoritesBusy;select.dataset.single=String(choices.size<2);
  select.onchange=()=>chooseFavoriteChannel(s,Number(select.value));row.insertBefore(select,row.querySelector('.favorite-star'));return row;
 }));
 $('favoritesEmpty').hidden=favorites.length>0;updateFavoriteStars();highlightStations();updateControls();
}
let mediaMetadataSignature = '';
let bluetoothCompat=false;
try{bluetoothCompat=localStorage.getItem('dab-bluetooth-compat')==='1';}catch{}
$('bluetoothCompat').checked=bluetoothCompat;
$('bluetoothCompat').onchange=()=>{
 bluetoothCompat=$('bluetoothCompat').checked;
 try{localStorage.setItem('dab-bluetooth-compat',bluetoothCompat?'1':'0');}catch{}
 mediaMetadataSignature='';updateMediaMetadata();
};
let lockScreenArtwork = [], lockScreenStation = '';
function updateMediaMetadata(){
 if(!('mediaSession' in navigator)||typeof MediaMetadata==='undefined')return;
 const cur=radio.current||{};
 if(!cur.playing){
  lockScreenArtwork=[];lockScreenStation='';
  if(mediaMetadataSignature){navigator.mediaSession.metadata=null;mediaMetadataSignature='';}
  return;
 }
 const img=$('slide');
 const station=radio.frequencyKHz+':'+cur.sid+':'+(cur.scids||0);
 if(station!==lockScreenStation||!cur.slideVersion){lockScreenArtwork=[];lockScreenStation=station;}
 // Only broadcast SLS images belong on the lock screen. Keep the previous
 // slide during loading of its successor, avoiding a transient empty artwork.
 if(img&&!img.hidden&&img.complete&&img.naturalWidth>0&&img.dataset.broadcastSlide==='true'){
  lockScreenArtwork=[{src:new URL(img.dataset.broadcastUrl||img.getAttribute('src'),location.href).href,sizes:img.naturalWidth+'x'+img.naturalHeight}];
 }
 const artwork=lockScreenArtwork;
 const receptionInfo=[radio.syncLevel===2&&radio.ensemble?.valid?radio.ensemble.label:'',radio.channel?'Canal '+radio.channel:'',typeof radio.snr==='number'&&Number.isFinite(radio.snr)?'SNR '+radio.snr.toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1})+' dB':''].filter(Boolean).join(' · ');
 const normalTitle=cur.dlPlusTitle||cur.dls||cur.label;
 const btSnr=typeof radio.snr==='number'&&Number.isFinite(radio.snr)?'SNR '+radio.snr.toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1})+' dB':'';
 const trackTitle=cur.dlPlusTitle?[cur.dlPlusTitle,cur.dlPlusArtist].filter(Boolean).join(' \u2014 '):normalTitle;
 const btTitle=bluetoothCompat?[trackTitle,btSnr].filter(Boolean).join(' \u00b7 '):normalTitle;
 const metadata={title:btTitle,artist:bluetoothCompat?cur.label:cur.dlPlusArtist||cur.label,album:receptionInfo,artwork};
 const signature=JSON.stringify(metadata);
 if(signature!==mediaMetadataSignature){
  try{
   const session=navigator.mediaSession,existing=session.metadata;
   // Notify individual field changes without rebuilding artwork on each SNR update.
   if(existing){
    if(existing.title!==metadata.title)existing.title=metadata.title;
    if(existing.artist!==metadata.artist)existing.artist=metadata.artist;
    if(existing.album!==metadata.album)existing.album=metadata.album;
    if(JSON.stringify(existing.artwork)!==JSON.stringify(artwork)){
     try{existing.artwork=artwork;}catch{existing.artwork=[];}
    }
   }else{
    try{session.metadata=new MediaMetadata(metadata);}
    catch{session.metadata=new MediaMetadata({...metadata,artwork:[]});}
   }
   mediaMetadataSignature=signature;
  }catch{/* Retry on the next receiver update without interrupting playback. */}
 }

}
audio.volume = .8;

async function api(path, data) {
 const controller = new AbortController(), timer = setTimeout(()=>controller.abort(), 22000);
 try {
  const r = await fetch(path, {signal:controller.signal, cache:'no-store', ...(data === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json','X-Gain-Control':'1'},body:JSON.stringify(data)})});
  const result = await r.json();
  if(!r.ok) throw Error(result.error || 'Le récepteur ne répond pas.');
  return result;
 } catch(e) {if(e.name === 'AbortError') throw Error('Le récepteur met trop de temps à répondre. Réessaie.'); throw e;}
 finally {clearTimeout(timer);}
}
function toast(message) {clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
function text(id,value){$(id).textContent=value;}
function element(tag, cls, value) {const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;}
function formatDate(value){return value ? new Date(value).toLocaleString('fr-FR',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : '—';}
function number(value,unit='',digits=1){return typeof value==='number'&&Number.isFinite(value)?value.toFixed(digits)+unit:'—';}
function scanMeasurementCurrent(){
 return scan.phase==='scanning'&&!!scan.channel&&radio.channel===scan.channel;
}
function scanReceptionInfo(){
 if(scan.phase==='restoring')return 'Retour à la station précédente…';
 const fresh=scanMeasurementCurrent();
 const mux=fresh&&radio.syncLevel===2&&radio.ensemble?.valid&&radio.services?.length?radio.ensemble.label:'';
 return [scan.channel?'Canal '+scan.channel:'Préparation du scan',fresh?'SNR '+number(radio.snr,' dB'):'Mesure en attente',mux||'Recherche du multiplex'].join(' · ');
}
function renderSnrQuality(available=true){
 const dot=$('snrQuality');let quality='unknown',label='Qualité de réception indisponible';
 if(scan.active&&!scanMeasurementCurrent()){label='Mesure en attente';}
 else if(available&&typeof radio.snr==='number'&&Number.isFinite(radio.snr)){
  if(radio.syncLevel!==2){quality='poor';label='Réception non synchronisée';}
  else if(radio.snr<6){quality='poor';label='Réception faible';}
  else if(radio.snr<10){quality='fair';label='Réception moyenne';}
  else{quality='good';label='Bonne réception';}
 }
 dot.dataset.quality=quality;dot.setAttribute('aria-label',label);
 const measured=available&&(!scan.active||scanMeasurementCurrent())&&typeof radio.snr==='number'&&Number.isFinite(radio.snr);
 const value=measured?radio.snr:0, bounded=Math.max(0,Math.min(20,value));
 $('snrCard').dataset.quality=quality;
 $('snrCard').style.setProperty('--snr-percent',(bounded*5)+'%');
 text('currentSnr',measured?value.toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1})+' dB':'—');
 text('snrLabel',label);
 $('snrMeter').setAttribute('aria-valuenow',String(bounded));
 $('snrMeter').setAttribute('aria-valuetext',measured?value.toFixed(1)+' dB · '+label:label);
 dot.title=label+' — repères SNR indicatifs : rouge < 6 dB, orange de 6 à moins de 10 dB, vert ≥ 10 dB. Rouge également si la synchronisation est perdue.';
}
let previousView='listen', favoritesReturnView='listen', favoritesReturnScroll=0;
function route(){
 const name=['listen','library','scan','settings','favorites','manual','mosaic','technical'].includes(location.hash.slice(1))?location.hash.slice(1):'listen';
 if(name==='favorites'&&previousView!=='favorites'){favoritesReturnView=previousView;favoritesReturnScroll=window.scrollY;}
 if(name!=='mosaic'&&mosaicExpanded)setMosaicExpanded(false);
 if(name==='mosaic'){renderMosaic();loadLibrary().catch(e=>toast(e.message));}
 const restoreFavoritesScroll=previousView==='favorites'&&name===favoritesReturnView;
 previousView=name;
 const shortcut=$('favoritesShortcut');
 shortcut.href='#'+(name==='favorites'?favoritesReturnView:'favorites');
 shortcut.setAttribute('aria-label',name==='favorites'?'Revenir à la page précédente':'Ouvrir les favoris');
 shortcut.title=name==='favorites'?'Revenir à la page précédente':'Favoris';
 if(name==='favorites'){renderFavorites();loadFavorites().catch(()=>{});}
 document.body.dataset.view=name;
 document.querySelectorAll('.view').forEach(e=>e.hidden=e.id!=='view-'+name);
 document.querySelectorAll('[data-view]').forEach(e=>{if(e.dataset.view===name)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');});
 if($('menuDialog').open)$('menuDialog').close();
 document.title=({technical:'Infos techniques',listen:'Écoute',library:'Mes multiplex',scan:'Scan auto',settings:'Réglages',favorites:'Favoris',manual:'Scan manuel',mosaic:'Mosa\u00efque radio'})[name]+' · AbracaDABra';
 window.scrollTo({top:restoreFavoritesScroll?favoritesReturnScroll:0,behavior:'instant'});
 if(name==='library'){updateFavoriteStars();loadFavorites().catch(e=>toast(e.message));loadLibrary().catch(e=>toast(e.message));}
}
window.addEventListener('hashchange',route);
$('menuOpen').onclick=()=>$('menuDialog').showModal();
$('menuClose').onclick=()=>$('menuDialog').close();
$('menuDialog').addEventListener('click',e=>{if(e.target===$('menuDialog'))$('menuDialog').close();});
$('menuDialog').querySelectorAll('a').forEach(a=>a.addEventListener('click',()=> $('menuDialog').close()));

function updateControls(){
 const unavailable=busy||scan.active;
 document.querySelectorAll('.mosaic-station').forEach(b=>b.disabled=unavailable);
 $('mosaicPlay').disabled=unavailable;
 updateMosaicPlayback();
 document.querySelectorAll('.favorite-channel').forEach(e=>e.disabled=unavailable||favoritesBusy||e.dataset.single==='true');
 $('expandedPlay').disabled=unavailable;
 $('expandedFavorite').disabled=busy||scan.active||favoritesBusy||!radio.current?.playing;
 ['expandedPrevious','expandedNext'].forEach(id=>$(id).disabled=unavailable||(location.hash==='#favorites'?orderedFavorites().length<1:(radio.services||[]).length<2));
 ['rfApply','rfAuto','scanStart'].forEach(id=>$(id).disabled=unavailable);
 $('rfGain').disabled=unavailable||$('rfAuto').checked;
 $('playPause').disabled=unavailable;
 $('heroPlay').disabled=unavailable;
 document.querySelectorAll('.channel-tile').forEach(e=>e.disabled=unavailable);
 document.querySelectorAll('.station-button,.mux-tune').forEach(e=>e.disabled=unavailable);
}
function playerUI(){
 const playing=!audio.paused||(wantedAudio&&networkRecovering);
 text('expandedPlay',playing?'Ⅱ':'▶');$('expandedPlay').setAttribute('aria-label',playing?'Mettre en pause':'Écouter le direct');
 text('playPause',playing?'Ⅱ':'▶');$('playPause').setAttribute('aria-label',playing?'Mettre en pause':'Écouter le direct');
 $('heroPlay').textContent=playing?'Mettre en pause  Ⅱ':'Écouter le direct  ▶';
 const reception=[radio.syncLevel===2&&radio.ensemble?.valid?radio.ensemble.label:'',radio.channel?'Canal '+radio.channel:'',typeof radio.snr==='number'&&Number.isFinite(radio.snr)?'SNR '+radio.snr.toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1})+' dB':''].filter(Boolean).join(' · ');
 const playerDetail=scan.active?scanReceptionInfo():networkRecovering?'Reconnexion au direct\u2026':busy?'Changement de station…':playing&&audio.readyState<2?'Chargement du direct…':!playing&&wantedAudio?'Reconnexion au direct…':reception||'Appuie sur Lecture pour écouter';
 for(const id of ['playerStatus','expandedReception']){
  const node=$(id),match=/SNR\s+-?\d+(?:[,.]\d+)?\s*dB/.exec(playerDetail);
  if(match){
   const value=element('span','player-snr',match[0]);value.dataset.quality=$('snrQuality').dataset.quality||'unknown';
   node.replaceChildren(document.createTextNode(playerDetail.slice(0,match.index)),value,document.createTextNode(playerDetail.slice(match.index+match[0].length)));
  }else node.textContent=playerDetail;
 }
 $('playerStatus').title=playerDetail;
 if('mediaSession' in navigator)navigator.mediaSession.playbackState=playing?'playing':'paused';
}
audio.addEventListener('playing',playerUI);audio.addEventListener('pause',playerUI);
audio.addEventListener('error',()=>{if(!interruptedPlayback)scheduleNetworkRecovery();playerUI();});
audio.addEventListener('ended',()=>scheduleNetworkRecovery());
for(const event of ['waiting','stalled'])audio.addEventListener(event,()=>scheduleNetworkRecovery(10000));
audio.addEventListener('playing',()=>{clearTimeout(networkRetryTimer);networkRetryTimer=null;networkRetryCount=0;networkRecovering=false;});
audio.addEventListener('timeupdate',()=>{if(!audio.paused&&audio.readyState>=3&&!networkRecovering){clearTimeout(networkRetryTimer);networkRetryTimer=null;networkRetryCount=0;}});
function cancelNetworkRecovery(){
 clearTimeout(networkRetryTimer);networkRetryTimer=null;networkRetryCount=0;networkRecovering=false;networkRetryGeneration++;
}
function scheduleNetworkRecovery(delay){
 if(!wantedAudio||busy||scan.active||interruptedPlayback||networkRetryTimer!==null)return;
 networkRecovering=true;
 const wait=delay??Math.min(15000,1000*2**Math.min(networkRetryCount,4));
 networkRetryTimer=setTimeout(reconnectNetworkAudio,wait);playerUI();
}
async function reconnectNetworkAudio(){
 networkRetryTimer=null;
 if(!wantedAudio||busy||scan.active||interruptedPlayback||navigator.audioSession?.state==='interrupted'){networkRecovering=false;return;}
 if(navigator.onLine===false){scheduleNetworkRecovery(3000);return;}
 const generation=++networkRetryGeneration;networkRetryCount++;
 audio.src='/stream/audio?_='+Date.now();
 // Watchdog also covers a play promise left pending by a dead connection.
 scheduleNetworkRecovery(15000);
 try{
  await audio.play();
  if(generation!==networkRetryGeneration)return;
  if(!wantedAudio){audio.pause();return;}
 }catch(e){
  if(generation!==networkRetryGeneration)return;
  clearTimeout(networkRetryTimer);networkRetryTimer=null;
  if(e.name==='NotAllowedError'){
   wantedAudio=false;cancelNetworkRecovery();toast('Appuie sur Lecture pour autoriser la reprise du son.');
  }else scheduleNetworkRecovery();
 }
 playerUI();
}
function retryOnNetworkReturn(){
 if(wantedAudio&&(networkRecovering||audio.error||audio.ended)){
  clearTimeout(networkRetryTimer);networkRetryTimer=null;scheduleNetworkRecovery(0);
 }
}
window.addEventListener('online',retryOnNetworkReturn);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)retryOnNetworkReturn();});
window.addEventListener('pageshow',retryOnNetworkReturn);

async function playAudio(){
 if(scan.active||busy)return;
 if(!radio.current?.playing){toast('Choisis une station dans la liste ou dans Mes multiplex.');return;}
 cancelNetworkRecovery();interruptedPlayback=false;interruptionAttempts=0;wantedAudio=true;
 audio.src='/stream/audio?_='+Date.now();
 try {await audio.play();}catch(e){if(wantedAudio){wantedAudio=false;toast('Appuie à nouveau sur Lecture pour autoriser le son.');}}
 playerUI();
}
async function toggleAudio(){if(!audio.paused||(wantedAudio&&networkRecovering)){cancelNetworkRecovery();wantedAudio=false;interruptedPlayback=false;audio.pause();playerUI();}else await playAudio();}
$('playPause').onclick=toggleAudio;$('heroPlay').onclick=toggleAudio;
 $('expandedPlay').onclick=toggleAudio;
 $('expandedPrevious').onclick=()=>stepStation(-1);$('expandedNext').onclick=()=>stepStation(1);
 function openExpandedPlayer(){if(!$('expandedPlayer').open){$('expandedPlayer').showModal();renderRadio();$('expandPlayer').setAttribute('aria-expanded','true');}}
 $('expandPlayer').onclick=openExpandedPlayer;
 $('expandPlayer').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openExpandedPlayer();}};
 $('collapsePlayer').onclick=()=>$('expandedPlayer').close();
 $('expandedPlayer').addEventListener('close',()=>{$('expandPlayer').setAttribute('aria-expanded','false');$('expandPlayer').focus({preventScroll:true});});
 $('expandedPlayer').addEventListener('click',e=>{if(e.target!==$('expandedPlayer'))return;const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();});
for(const id of ['volume','settingsVolume'])$(id).oninput=()=>{audio.volume=Number($(id).value)/100;$('volume').value=$(id).value;$('settingsVolume').value=$(id).value;};
let stationNavigationPending=false;
async function stepStation(direction){
 if(busy||scan.active||stationNavigationPending)return;
 stationNavigationPending=true;
 try{
  // Refresh before navigating: another listener may have changed the multiplex.
  const [state,scanState]=await Promise.all([api('/api/status'),api('/scan/status')]);
  if(busy||scanState.active)return;
  const favoriteMode=location.hash==='#favorites';
  if(favoriteMode)await loadFavorites();
  const stations=favoriteMode?orderedFavorites():state.services||[];
  if(!stations.length)return;
  if(stations.length<2&&favoriteKey(stations[0])===favoriteKey(state.current||{}))return;
  const current=stations.findIndex(s=>favoriteKey(s)===favoriteKey(state.current||{}));
  const next=current<0?(direction>0?0:stations.length-1):(current+direction+stations.length)%stations.length;
  await selectStation(favoriteMode?stations[next].frequencyKHz:state.frequencyKHz,stations[next]);
 }catch(e){toast(e.message);}
 finally{stationNavigationPending=false;}
}
async function playFromMediaControls(){

 if(scan.active||busy)return;
 // A Bluetooth play command is explicit consent to resume. Reuse the media
 // element immediately, before any network request or stream replacement.
 wantedAudio=true;interruptionAttempts=0;
 try{
  if(!audio.getAttribute('src')||audio.error||audio.ended){
   if(!radio.current?.playing)return;
   audio.src='/stream/audio?_='+Date.now();
  }
  await audio.play();
  if(!wantedAudio){audio.pause();return;}
  interruptedPlayback=false;
 }catch{
  interruptedPlayback=true;
  // Keep intent so returning to Safari can retry if iOS blocks background play.
 }finally{playerUI();}
}
function registerMediaControls(){
 if(!('mediaSession' in navigator))return;
 const handlers={play:playFromMediaControls,pause:()=>{cancelNetworkRecovery();wantedAudio=false;interruptedPlayback=false;audio.pause();},previoustrack:()=>stepStation(-1),nexttrack:()=>stepStation(1),seekbackward:null,seekforward:null,seekto:null};
 for(const [action,handler] of Object.entries(handlers)){
  try{navigator.mediaSession.setActionHandler(action,handler);}catch{/* Unsupported action on this browser. */}
 }
}
registerMediaControls();
audio.addEventListener('playing',registerMediaControls);

let pendingManualFrequency=null;
async function selectFirstManualStation(){
 if(pendingManualFrequency===null||busy)return;
 if(scan.active){pendingManualFrequency=null;return;}
 if(Number(radio.frequencyKHz)!==pendingManualFrequency)return;
 if(radio.syncLevel!==2||!radio.ensemble?.valid||!radio.services?.length)return;
 const frequency=pendingManualFrequency;pendingManualFrequency=null;
 if(radio.current?.playing)return;
 await selectStation(frequency,radio.services[0],false);
}
async function selectStation(frequency, station, autoplay=true, alternatives=[]){
 if(busy||scan.active)return;
 pendingManualFrequency=null;
 busy=true;updateControls();cancelNetworkRecovery();wantedAudio=false;interruptedPlayback=false;recoveryPending=false;audio.pause();
 audio.removeAttribute('src');audio.load();
 text('playerStatus','Réception de la station…');
 try {
  const frequencies=station?[...new Set([frequency,...alternatives].map(Number))]:[Number(frequency)];
  let received=false,lastError=null;
  for(let attempt=0;attempt<frequencies.length;attempt++){
   if(scan.active)throw new Error('Le scan utilise le r\u00e9cepteur.');
   frequency=frequencies[attempt];
   if(frequencies.length>1){const channel=channels.find(c=>c.frequencyKHz===frequency)?.channel||frequency/1000+' MHz';toast('Recherche de '+station.label+' \u00b7 '+channel+' ('+(attempt+1)+'/'+frequencies.length+')');}
   try{
    await api('/receiver/select',{frequencyKHz:frequency,...(station?{sid:String(station.sid),scids:station.scids||0}:{})});
    radio=await api('/api/status');renderRadio();
    if(!station){received=true;break;}
    const matches=state=>Number(state.frequencyKHz)===frequency&&state.syncLevel===2&&state.current?.playing&&favoriteKey(state.current)===favoriteKey(station);
    const deadline=Date.now()+15000;
    while(!matches(radio)&&Date.now()<deadline&&!scan.active){await new Promise(r=>setTimeout(r,300));radio=await api('/api/status');}
    if(scan.active)throw new Error('Le scan utilise le r\u00e9cepteur.');
    if(matches(radio)){received=true;break;}
   }catch(e){lastError=e;}
  }
  if(!received)throw new Error(scan.active?'Le scan utilise le r\u00e9cepteur.':frequencies.length>1?'Cette radio n\u2019est re\u00e7ue sur aucun de ses canaux m\u00e9moris\u00e9s.':lastError?.message||'Cette radio n\u2019est pas re\u00e7ue sur le canal choisi. Essaie un autre canal.');
  if(station){
   renderRadio();busy=false;updateControls();if(autoplay)await playAudio();
  } else {if(location.hash==='#manual')pendingManualFrequency=Number(frequency);if(location.hash!=='#manual')location.hash='listen';toast('Canal sélectionné. Les stations apparaîtront dès leur réception.');}
  loadLibrary().catch(()=>{});
 }catch(e){wantedAudio=false;toast(e.message);}
 finally{busy=false;updateControls();playerUI();}
}
function stationFallbackName(station){
 return String(station.labelShort||station.shortLabel||station.label||'Radio').trim()||'Radio';
}
function stationButton(station, frequency){
 const b=element('button','station-button');b.type='button';
 b.dataset.sid=station.sid;b.dataset.frequency=frequency;b.dataset.scids=station.scids||0;
 const fallbackName=stationFallbackName(station);
 const icon=element('span','station-icon station-name-fallback',fallbackName);
 const logoKey=Number(station.sid).toString(16)+'.'+(station.scids||0);
 const logo=stationLogos[logoKey];
 if(logo){
  const img=element('img','station-logo');img.alt='';img.loading='lazy';img.src=logo;
  img.onload=()=>{icon.classList.add('has-logo');icon.classList.remove('station-name-fallback');};
  img.onerror=()=>{img.remove();icon.textContent=fallbackName;icon.classList.remove('has-logo');icon.classList.add('station-name-fallback');};
  icon.replaceChildren(img);
 }
 b.append(icon);
 const copy=element('span','station-copy');copy.append(element('strong','',station.label||'Station sans nom'),element('small','',(station.bitRate?station.bitRate+' kbit/s':'DAB / DAB+')+' · Écouter'));
 b.append(copy,element('span','station-arrow','▶'));b.setAttribute('aria-label','Écouter '+(station.label||'cette station'));
 b.onclick=()=>selectStation(frequency,station);
 bindLogoSearch(b,station);
 const wrapper=element('div','station-item'),star=element('button','favorite-star');star.type='button';star.dataset.key=favoriteKey(station,frequency);star.dataset.label=station.label||'Station';
 const selected=favorites.some(s=>favoriteKey(s,s.frequencyKHz)===star.dataset.key);star.textContent=selected?'★':'☆';star.setAttribute('aria-pressed',String(selected));star.setAttribute('aria-label',(selected?'Retirer des favoris : ':'Ajouter aux favoris : ')+star.dataset.label);star.onclick=()=>toggleFavorite(station,frequency);
 wrapper.append(b,star);return wrapper;
}
function highlightStations(){document.querySelectorAll('.station-button,.mosaic-station').forEach(b=>{const active=radio.current?.playing&&(b.classList.contains('mosaic-station')||Number(b.dataset.frequency)===radio.frequencyKHz)&&Number(b.dataset.sid)===Number(radio.current.sid)&&Number(b.dataset.scids)===radio.current.scids;b.classList.toggle('selected',!!active);b.setAttribute('aria-pressed',String(!!active));});}
function renderRadio(){
 renderTechnical();
 renderManual();
 const cur=radio.current||{}, adv=radio.advanced||{};
 const dls=!scan.active&&cur.playing?(cur.dls||[cur.dlPlusArtist,cur.dlPlusTitle].filter(Boolean).join(' — ')):'';
 text('playerDls',dls);$('playerDls').hidden=!dls;$('playerDls').title=dls;
 text('stationName',scan.active?'Exploration en cours':cur.playing?cur.label:'Choisis une station');text('playerName',cur.playing?cur.label:scan.active?'Scan de la bande DAB':'Aucune station');
 text('stationState',scan.active?'RECHERCHE EN COURS':cur.playing?'EN DIRECT':'RÉCEPTEUR PRÊT');
 text('stationTitle',scan.active?'Les multiplex reçus sont ajoutés à ta bibliothèque.':cur.playing?(cur.dlPlusTitle?[cur.dlPlusArtist,cur.dlPlusTitle].filter(Boolean).join(' — '):cur.dls||'Le direct, sans interruption.'):'Sélectionne une radio ou explore la bande DAB.');
 text('stationMux',!scan.active&&radio.syncLevel===2&&radio.ensemble?.valid?radio.ensemble.label+' · '+(radio.channel||''):'');
 renderSnrQuality();
 text('expandedStation',$('stationName').textContent);
 const favoriteButton=$('expandedFavorite');
 favoriteButton.dataset.key=cur.playing?favoriteKey(cur):'';
 favoriteButton.dataset.label=cur.label||'Radio';
 updateFavoriteStars();
 const title=!scan.active&&cur.playing?[cur.dlPlusArtist,cur.dlPlusTitle].filter(Boolean).join(' — '):'';
 text('expandedTitle',title);$('expandedTitle').hidden=!title;
 const normalizeCaption=value=>value.toLocaleLowerCase('fr').replace(/[\s—–-]+/g,' ').trim();
 text('expandedDls',dls);$('expandedDls').hidden=!dls||normalizeCaption(dls)===normalizeCaption(title);
 if($('expandedPlayer').open){const signal=$('snrCard').cloneNode(true);signal.removeAttribute('id');signal.querySelectorAll('[id]').forEach(e=>e.removeAttribute('id'));$('expandedSignal').replaceChildren(signal);}
 const stationLogo=cur.playing?stationLogos[Number(cur.sid).toString(16)+'.'+(cur.scids||0)]:null;
 const slideId=cur.playing&&cur.slideVersion?radio.frequencyKHz+':'+cur.sid+':'+cur.slideVersion:'';
 const slideUrl=slideId?'/api/slideshow?v='+encodeURIComponent(slideId):'';
 const artworkOwner=cur.playing?[radio.frequencyKHz,Number(cur.sid),Number(cur.scids||0)].join(':'):'';
 const key=artworkOwner+'|'+(slideId||'')+'|'+(stationLogo||'');
 if(key!==slideKey||(artworkRetryAt&&Date.now()>=artworkRetryAt)){
  slideKey=key;artworkRetryAt=0;
  const targets=[['slide','artPlaceholder'],['playerSlide','playerArtPlaceholder'],['expandedSlide','expandedPlaceholder']].map(([i,p])=>[$(i),$(p)]);
  for(const [img,placeholder] of targets){
   if(img.dataset.artworkOwner!==artworkOwner||!artworkOwner){
    img.hidden=true;img.removeAttribute('src');delete img.dataset.broadcastSlide;delete img.dataset.broadcastUrl;placeholder.hidden=false;
    img.dataset.artworkOwner=artworkOwner;
   }
  }
  const hasArtwork=()=>targets.some(([img])=>!img.hidden&&img.hasAttribute('src'));
  const loadArtwork=async(url,isSlide)=>{
   const pending=new Image();
   pending.onload=async()=>{
    try{await pending.decode();}catch{}
    if(slideKey!==key)return;
    for(const [img,placeholder] of targets){
     img.alt=(isSlide?'Diaporama de ':'Logo de ')+(cur.label||'la station');
     img.dataset.broadcastSlide=String(isSlide);if(isSlide)img.dataset.broadcastUrl=url;else delete img.dataset.broadcastUrl;img.src=pending.src;img.hidden=false;placeholder.hidden=true;
    }
    updateMediaMetadata();
   };
   pending.onerror=()=>{
    if(slideKey!==key)return;
    artworkRetryAt=Date.now()+2000;
    // Keep the current image through transient errors; never flash the fallback.
    if(isSlide&&stationLogo&&!hasArtwork())loadArtwork(stationLogo,false);
   };
   const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),8000);
   try{
    const response=await fetch(url,{cache:'no-store',signal:controller.signal});
    if(!response.ok)throw Error('Image indisponible');
    const blob=await response.blob();
    const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob);});
    if(slideKey===key)pending.src=dataUrl;
   }catch{pending.onerror();}finally{clearTimeout(timeout);}

  };
  if(slideUrl||stationLogo)loadArtwork(slideUrl||stationLogo,!!slideUrl);
 }
 const services=scan.active?[]:(radio.services||[]);
 const signature=JSON.stringify([radio.frequencyKHz,services]);
 if(signature!==serviceSignature){serviceSignature=signature;$('services').replaceChildren(...services.map(s=>stationButton(s,radio.frequencyKHz)));}
 $('servicesEmpty').hidden=services.length>0||scan.active;text('servicesMeta',scan.active?'Le scan utilise le récepteur.':services.length+' station'+(services.length===1?'':'s')+' · '+(radio.ensemble?.label||radio.channel||'Aucun multiplex'));
 updateMediaMetadata();
 highlightStations();updateControls();playerUI();
}
async function loadLibrary(){library=await api('/library');lastLibraryLoad=Date.now();renderLibrary();renderBand();renderFavorites();renderMosaic();}
async function loadLogos(){
 const next=await api('/api/logos');lastLogoLoad=Date.now();
 if(JSON.stringify(next)!==JSON.stringify(stationLogos)){
  stationLogos=next;serviceSignature='';librarySignature='';renderLibrary();renderFavorites();renderMosaic();renderRadio();
 }
}
let deletingMux=null;
function askDeleteMux(m){
 deletingMux=m.id;text('deleteMuxText',m.label+' - Canal '+m.channel);
 if(!$('deleteMuxDialog').open)$('deleteMuxDialog').showModal();
}
$('deleteMuxCancel').onclick=()=>$('deleteMuxDialog').close();
$('deleteMuxConfirm').onclick=async()=>{
 if(!deletingMux)return;
 $('deleteMuxConfirm').disabled=true;
 try{library=await api('/library/delete',{id:deletingMux});$('deleteMuxDialog').close();librarySignature='';renderLibrary();renderBand();renderFavorites();renderMosaic();toast('Multiplex supprim\u00e9.');}
 catch(e){toast(e.message);}
 finally{$('deleteMuxConfirm').disabled=false;}
};
function bindMuxLongPress(summary,m){
 let timer=null,start=null,suppressClick=false;
 const cancel=()=>{clearTimeout(timer);timer=null;start=null;};
 summary.addEventListener('pointerdown',e=>{
  if(e.button!==0||!e.isPrimary)return;cancel();suppressClick=false;start={x:e.clientX,y:e.clientY};
  timer=setTimeout(()=>{suppressClick=true;cancel();askDeleteMux(m);},650);
 });
 summary.addEventListener('pointermove',e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>10)cancel();});
 for(const name of ['pointerup','pointercancel','pointerleave'])summary.addEventListener(name,cancel);
 summary.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopPropagation();suppressClick=false;}});
 summary.addEventListener('contextmenu',e=>{e.preventDefault();cancel();askDeleteMux(m);});
 summary.addEventListener('keydown',e=>{if(e.key==='Delete'){e.preventDefault();askDeleteMux(m);}});
 summary.title='Appui long ou clic droit pour supprimer';
}
function renderLibrary(){
 const query=$('librarySearch').value.toLocaleLowerCase('fr').trim();
 const signature=JSON.stringify([library,query]);if(signature===librarySignature)return;librarySignature=signature;
 const opened=new Set([...document.querySelectorAll('.mux-card[open]')].map(x=>x.dataset.id));
 const muxes=library.multiplexes.filter(m=>[m.label,m.channel,...m.services.map(s=>s.label)].join(' ').toLocaleLowerCase('fr').includes(query));
 $('libraryCount').textContent=library.multiplexes.length+' multiplex mémorisé'+(library.multiplexes.length===1?'':'s');
 $('libraryEmpty').hidden=library.multiplexes.length>0;
 $('multiplexes').replaceChildren(...muxes.map(m=>{
  const card=element('details','mux-card');card.dataset.id=m.id;card.open=opened.has(m.id)||!!query;
  const summary=element('summary'), title=element('span','mux-title');
  title.append(element('strong','',m.label),element('small','',(m.frequencyKHz/1000).toFixed(3)+' MHz · '+(m.stationListPending?'Liste à réacquérir':m.services.length+' stations')));
  summary.append(element('span','mux-channel',m.channel),title,element('span','mux-expand','+'));
  bindMuxLongPress(summary,m);
  const content=element('div','mux-content');content.append(element('p','mux-date','Dernière réception : '+formatDate(m.lastSeen)+(m.lastScanId===library.lastScan?.id?' · Reçu au dernier scan':'')));
  const actions=element('div','mux-actions'), tune=element('button','secondary mux-tune','Recevoir ce multiplex');tune.onclick=()=>selectStation(m.frequencyKHz);actions.append(tune,element('span','muted','SNR '+number(m.snr,' dB')));content.append(actions);
  if(m.stationListPending)content.append(element('p','muted','Liste précédente mélangée : les stations seront mises à jour à la prochaine réception de ce multiplex.'));
  const grid=element('div','station-grid');grid.append(...m.services.filter(s=>!query||[m.label,m.channel,s.label].join(' ').toLocaleLowerCase('fr').includes(query)).map(s=>stationButton(s,m.frequencyKHz)));content.append(grid);card.append(summary,content);return card;
 }));
 if(query&&!muxes.length)$('multiplexes').append(element('p','empty','Aucun résultat pour cette recherche.'));
 text('lastScan',library.lastScan?'Dernier scan : '+formatDate(library.lastScan.endedAt||library.lastScan.startedAt):'');
 updateFavoriteStars();highlightStations();updateControls();
}
$('librarySearch').oninput=renderLibrary;
let sessionDetectionsSignature='';
function renderSessionDetections(){
 const detections=scan.detections||[];
 const signature=JSON.stringify(detections);if(signature===sessionDetectionsSignature)return;sessionDetectionsSignature=signature;
 $('scanSessionEmpty').hidden=detections.length>0;
 $('scanSessionMuxes').replaceChildren(...[...detections].sort((a,b)=>a.frequencyKHz-b.frequencyKHz||a.label.localeCompare(b.label,'fr')).map(m=>{
  const card=element('article','session-mux-row');
  const name=element('strong','session-mux-name',m.label);name.title=m.label;
  card.append(element('span','session-mux-channel',m.channel),name,element('strong','session-mux-snr','SNR '+number(m.snr,' dB')));
  const date=m.lastSeen?new Date(m.lastSeen).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'Date inconnue';
  const count=element('span','session-mux-count','× '+m.count);count.title=m.count+' détection'+(m.count>1?'s':'');count.setAttribute('aria-label',count.title);
  card.append(element('time','muted',date),count);return card;
 }));
}
let selectedBandChannel=null,bandDetailsSignature='';
function renderBandDetails(){
 const muxes=library.multiplexes.filter(m=>m.channel===selectedBandChannel).sort((a,b)=>String(b.lastSeen).localeCompare(String(a.lastSeen)));
 const signature=JSON.stringify([selectedBandChannel,muxes]);if(signature===bandDetailsSignature)return;bandDetailsSignature=signature;
 $('bandDetails').hidden=!selectedBandChannel;
 text('bandDetailsTitle','Canal '+selectedBandChannel+' - '+muxes.length+' multiplex');
 $('bandMuxes').replaceChildren(...muxes.map(m=>{
  const card=element('article','band-mux');card.append(element('h3','',m.label||'Multiplex sans nom'));
  const date=m.lastSeen?new Date(m.lastSeen).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Date inconnue';
  card.append(element('p','muted',date),element('strong','band-mux-snr','SNR '+number(m.snr,' dB')));
  card.append(element('small','muted',(m.services||[]).length+' stations - EID '+(m.eid??'?')));return card;
 }));
}
function renderBand(){
 renderBandDetails();
 const received=new Set((scan.detections||[]).map(m=>m.channel));
 const saved=new Set(library.multiplexes.map(m=>m.channel));
 for(const e of $('bandGrid').children){e.classList.toggle('found',received.has(e.dataset.channel));e.classList.toggle('current',scan.active&&scan.channel===e.dataset.channel);e.disabled=!saved.has(e.dataset.channel);e.setAttribute('aria-expanded',String(e.dataset.channel===selectedBandChannel));e.classList.toggle('selected',e.dataset.channel===selectedBandChannel);e.title=e.dataset.channel+(received.has(e.dataset.channel)?' · Reçu durant cette session':saved.has(e.dataset.channel)?' · Historique des multiplex':'');}
}
let scanStopPending=false;
async function stopScan(){
 if(scanStopPending)return;
 scanStopPending=true;renderScan();
 try{scan=await api('/scan/cancel',{});renderScan();}
 catch(e){scanStopPending=false;renderScan();toast(e.message);}
}
$('quickScanStop').onclick=()=>{
 if(scanStopPending||!scan.active)return;
 if(!$('scanStopDialog').open)$('scanStopDialog').showModal();
};
$('scanStopKeep').onclick=()=>$('scanStopDialog').close();
$('scanStopConfirm').onclick=()=>{
 $('scanStopDialog').close();
 if(scan.active&&!scanStopPending)stopScan();
};
function renderScan(){
 renderSessionDetections();
 if(!scan.active)scanStopPending=false;
 $('quickScanStop').hidden=!scan.active||scanStopPending||scan.phase==='restoring';
 $('scanRepeat').disabled=scan.active;
 if(scan.active)$('scanRepeat').checked=!!scan.repeat;
 document.body.classList.toggle('scan-running',!!scan.active);

 $('scanBanner').hidden=!scan.active;text('scanBannerText',(scan.phase==='restoring'?'Retour à la station…':'Scan · '+(scan.channel||'Préparation'))+' · '+scan.completed+'/'+scan.total);
 text('scanTitle',scan.active?(scan.phase==='restoring'?'On retrouve ton direct.':'À la recherche des radios…'):scan.phase==='completed'?'La bande a livré ses radios.':scan.phase==='cancelled'?'Recherche arrêtée.':'Quelles radios autour de toi ?');
 text('scanChannel',scan.channel||'5A → 13F');text('scanProgressCount',scan.completed+' / '+scan.total);text('scanFound',scan.found);
 $('scanProgress').value=scan.completed;$('scanProgress').max=scan.total;
 text('scanMessage',[scan.active&&scan.repeat?'Scan en boucle - passage '+(scan.cycle||1):'',scan.message,scan.error].filter(Boolean).join(' '));
 $('scanStart').hidden=scan.active;$('scanCancel').hidden=!scan.active;$('scanCancel').disabled=scan.phase==='restoring';
 $('view-scan').classList.toggle('scanning',scan.active);renderBand();updateControls();playerUI();
}
$('scanStart').onclick=async()=>{
 if(busy||scan.active)return;busy=true;updateControls();
 wantedAudio=!audio.paused;audio.pause();
 try{scan=await api('/scan/start',{repeat:$('scanRepeat').checked});remoteScanSeen=true;renderScan();toast('Scan lancé. Les découvertes sont sauvegardées au fur et à mesure.');}
 catch(e){toast(e.message);if(wantedAudio){busy=false;await playAudio();}}
 finally{busy=false;updateControls();}
};
$('scanCancel').onclick=stopScan;
function gainDisplay(){text('rfValue','Niveau '+$('rfGain').value+' / '+$('rfGain').max);updateControls();}
$('rfAuto').onchange=gainDisplay;$('rfGain').oninput=gainDisplay;
$('rfApply').onclick=async()=>{
 if(busy||scan.active)return;busy=true;updateControls();wantedAudio=!audio.paused;audio.pause();text('rfMessage','Application du gain et redémarrage…');
 try{gain=await api('/gain-control',{automatic:$('rfAuto').checked,index:Number($('rfGain').value)});text('rfMessage','Gain enregistré. Le récepteur retrouve la station.');recoveryPending=wantedAudio;}
 catch(e){text('rfMessage',e.message);toast(e.message);}
 finally{busy=false;updateControls();}
};
let pollRunning=false,pollTimer,lastPollStarted=0;
let scanRefreshRunning=false;
async function refreshScanState(){
 if(scanRefreshRunning)return;
 scanRefreshRunning=true;
 try{
  const nextScan=await api('/scan/status');
  if(nextScan.active&&!remoteScanSeen){wantedAudio=!audio.paused;audio.pause();remoteScanSeen=true;}
  if(!nextScan.active&&remoteScanSeen){remoteScanSeen=false;recoveryPending=wantedAudio;loadLibrary().catch(()=>{});toast(nextScan.message);}
  scan=nextScan;renderScan();
 }catch{/* A slow scan status must not delay reception metadata. */}
 finally{scanRefreshRunning=false;}
}
async function poll(){
 if(pollRunning)return;
 clearTimeout(pollTimer);pollRunning=true;lastPollStarted=Date.now();
 try{
  refreshScanState();
  const nextRadio=await api('/api/status');
  radio=nextRadio;updateMediaMetadata();renderRadio();renderDeviceConnection(radio);
  await selectFirstManualStation();
  if(recoveryPending&&!scan.active&&!busy&&radio.current?.playing){recoveryPending=false;if(wantedAudio)await playAudio();}
  if(radio.libraryChanged||Date.now()-lastLibraryLoad>(scan.active?3500:15000))loadLibrary().catch(()=>{});
  if(Date.now()-lastFavoritesLoad>5000)loadFavorites().catch(()=>{lastFavoritesLoad=Date.now();});
  if(Date.now()-lastLogoLoad>60000)loadLogos().catch(()=>{lastLogoLoad=Date.now();});
 }catch(e){renderDeviceConnection(null);renderSnrQuality(false);renderTechnical(false);}
 finally{pollRunning=false;pollTimer=setTimeout(poll,Math.max(250,1000-(Date.now()-lastPollStarted)));}
}
function refreshReception(){if(lastPollStarted&&Date.now()-lastPollStarted>=1000)poll();}
audio.addEventListener('timeupdate',refreshReception);
audio.addEventListener('playing',refreshReception);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshReception();});
window.addEventListener('pageshow',refreshReception);
async function init(){
 route();
 // Show the shared receiver immediately, independently of settings and artwork.
 poll();
 loadFavorites().catch(()=>{});
 try{
  const c=await api('/api/channels');channels=c.channels.filter(x=>x.frequencyKHz>=174928&&x.frequencyKHz<=239200);
  $('manualChannels').replaceChildren(...channels.map(c=>{
   const b=element('button','manual-bar');b.type='button';b.dataset.frequency=c.frequencyKHz;b.dataset.channel=c.channel;b.setAttribute('aria-controls','manualDetails');
   const track=element('span','manual-bar-track');track.setAttribute('aria-hidden','true');track.append(element('span','manual-bar-fill'));
   b.append(element('small','bar-value','\u2014'),track,element('strong','',c.channel));
   b.onclick=()=>{manualDetailFrequency=Number(c.frequencyKHz);renderManual();$('manualDetails').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'nearest'});};return b;
  }));
  $('bandGrid').replaceChildren(...channels.map(c=>{const d=element('button','band-cell',c.channel);d.type='button';d.dataset.channel=c.channel;d.setAttribute('aria-controls','bandDetails');d.onclick=()=>{selectedBandChannel=selectedBandChannel===c.channel?null:c.channel;renderBand();};return d;}));
  gain=await api('/gain-control');$('rfAuto').checked=gain.automatic;$('rfGain').max=gain.gains.length-1;$('rfGain').value=gain.index;gainDisplay();
  await loadLogos();await loadLibrary();
 }catch(e){toast(e.message);}
}
init();

// Name reported by the installed receiver when opening its RTL-SDR device.
function renderDeviceConnection(state){
 const el=$('connection');
 const name=state?.deviceName || 'Generic RTL2832U OEM';
 const connected=state?.deviceReady === true && !state?.deviceError;
 const status=state ? (connected ? 'Connect\u00e9e' : 'D\u00e9connect\u00e9e') : 'Connexion au serveur perdue';
 el.replaceChildren();
 const label=document.createElement('span');label.className='device-name';label.textContent=name;
 const detail=document.createElement('small');detail.textContent=status;
 el.append(label,detail);
 el.classList.toggle('online',connected);
 el.title=name+' \u00b7 '+status+(state?.deviceError ? ' : '+state.deviceError : '');
}

function mosaicNormalize(value){return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr').trim();}
$('mosaicSearch').addEventListener('input',()=>renderMosaic());
function renderMosaic(){
 // Reception timestamps and SNR change on tuning, but do not change the wall.
 const mosaicData=library.multiplexes.map(m=>[m.frequencyKHz,m.ecc,m.eid,m.label,m.channel,(m.services||[]).map(s=>[s.sid,s.scids,s.label,s.labelShort,s.shortLabel])]);
 const signature=JSON.stringify([mosaicData,stationLogos,$('mosaicSearch').value]);
 if(signature===mosaicSignature)return;
 mosaicSignature=signature;
 let count=0;
 const groups=groupMosaicStations().map(category=>{
  const query=mosaicNormalize($('mosaicSearch').value).split(/\s+/).filter(Boolean);
  const stations=category.stations.filter(entry=>{
   const variants=library.multiplexes.filter(m=>(m.services||[]).some(s=>favoriteKey(s)===favoriteKey(entry.station)));
   const country=entry.country==='unknown'?'':new Intl.DisplayNames(['fr'],{type:'region'}).of(entry.country);
   const searchable=mosaicNormalize([entry.station.label,category.label,country,...variants.flatMap(m=>[m.label,m.channel,...m.services.filter(s=>favoriteKey(s)===favoriteKey(entry.station)).map(s=>s.label)])].join(' '));
   return query.every(word=>searchable.includes(word));
  });
  if(!stations.length)return null;
  const group=element('section','mosaic-group');group.dataset.id=category.id;
  const heading=element('h2','mosaic-group-title',category.label);group.append(heading);
  const grid=element('div','mosaic-grid');
  for(const entry of stations){
   const station=entry.station,m=entry.mux;
   const label=station.label||'Station';
   const b=element('button','mosaic-station');b.type='button';
   b.dataset.sid=station.sid;b.dataset.scids=station.scids||0;b.dataset.frequency=m.frequencyKHz;
   b.title=label+' \u00b7 '+m.label+' \u00b7 '+m.channel;
   b.setAttribute('aria-label','\u00c9couter '+b.title);b.setAttribute('aria-pressed','false');
   const fallback=()=>{b.replaceChildren(element('span','mosaic-name',stationFallbackName(station)));};
   const logo=stationLogos[Number(station.sid).toString(16)+'.'+(station.scids||0)];
   if(logo){const img=element('img');img.src=logo;img.alt='';img.loading='lazy';img.decoding='async';img.onerror=fallback;b.append(img);}else fallback();
   b.onclick=()=>selectMosaicStation(station);
   bindLogoSearch(b,station);
   grid.append(b);count++;
  }
  group.append(grid);return group;
 }).filter(Boolean);
 $('mosaicGroups').replaceChildren(...groups);const populated=library.multiplexes.some(m=>m.services?.length);$('mosaicEmpty').hidden=populated;$('mosaicNoResults').hidden=!populated||count>0;
 highlightStations();updateControls();
}
function updateMosaicPlayback(){
 const b=$('mosaicPlay');if(!b)return;
 const playing=!audio.paused||(wantedAudio&&networkRecovering);
 b.setAttribute('aria-label',playing?'Mettre en pause':'Reprendre la lecture');
 b.innerHTML=playing?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>';
}
function setMosaicExpanded(expanded){
 mosaicExpanded=expanded;document.body.classList.toggle('mosaic-expanded',expanded);
 const b=$('mosaicFullscreen');b.setAttribute('aria-pressed',String(expanded));
 b.setAttribute('aria-label',expanded?'R\u00e9duire la mosa\u00efque':'Agrandir la mosa\u00efque');b.title=b.getAttribute('aria-label');
 b.innerHTML=expanded?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h5V3m8 0v5h5M3 16h5v5m8 0v-5h5"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>';
 $('mosaicPlay').hidden=!expanded;
 if(!expanded&&mosaicNativeFullscreen&&document.fullscreenElement){document.exitFullscreen().catch(()=>{});}
}
$('mosaicFullscreen').onclick=()=>{
 const expanded=!mosaicExpanded;setMosaicExpanded(expanded);
 if(expanded&&document.documentElement.requestFullscreen){document.documentElement.requestFullscreen().then(()=>{mosaicNativeFullscreen=true;if(!mosaicExpanded)document.exitFullscreen().catch(()=>{});}).catch(()=>{});}
};
$('mosaicPlay').onclick=()=>$('playPause').click();
for(const event of ['play','pause','ended'])audio.addEventListener(event,updateMosaicPlayback);
document.addEventListener('fullscreenchange',()=>{if(mosaicNativeFullscreen&&!document.fullscreenElement){mosaicNativeFullscreen=false;setMosaicExpanded(false);}});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&mosaicExpanded)setMosaicExpanded(false);});

function mosaicFrequencies(station){
 const key=favoriteKey(station);
 const matches=library.multiplexes.filter(m=>(m.services||[]).some(s=>favoriteKey(s)===key));
 const currentReceived=!scan.active&&radio.syncLevel===2&&(radio.services||[]).some(s=>favoriteKey(s)===key);
 const isLive=m=>currentReceived&&Number(m.frequencyKHz)===Number(radio.frequencyKHz)&&Number(m.eid)===Number(radio.ensemble?.eid)&&Number(m.ecc)===Number(radio.ensemble?.ecc);
 const score=m=>{const value=isLive(m)?radio.snr:m.snr;return typeof value==='number'&&Number.isFinite(value)?value:-Infinity;};
 matches.sort((a,b)=>{
  const aScore=score(a),bScore=score(b);
  if(aScore!==bScore)return bScore>aScore?1:-1;
  return Number(isLive(b))-Number(isLive(a))||String(b.lastSeen||'').localeCompare(String(a.lastSeen||''));
 });
 return [...new Set(matches.map(m=>Number(m.frequencyKHz)))];
}
async function selectMosaicStation(station){
 if(busy||scan.active)return;
 const frequencies=mosaicFrequencies(station);
 if(!frequencies.length){toast('Cette radio n\u2019est plus m\u00e9moris\u00e9e.');return;}
 await selectStation(frequencies[0],station,true,frequencies.slice(1));
}

function mosaicCountry(station,mux){
 const sid=Number(station.sid),ecc=sid>65535?(sid>>>16)&255:Number(mux.ecc);
 const gcc=((sid>>>12)&15).toString(16)+ecc.toString(16).padStart(2,'0');
 // ETSI TS 101 756, European country identifiers and extended country codes.
 const countries={'fe1':'FR','6e0':'BE','de0':'DE','1e0':'DE','7e1':'LU','8e3':'NL','ce1':'GB','4e1':'CH','9e1':'DK','ae0':'AT','5e0':'IT','ee2':'ES','8e4':'PT','fe2':'NO','ee3':'SE','6e1':'FI','2e3':'IE','3e2':'PL','2e2':'CZ','5e2':'SK','be0':'HU','9e4':'SI','ce3':'HR','ee1':'RO','8e1':'BG','1e1':'GR','2e0':'DZ','1e2':'MA','7e2':'TN','2e1':'CY','ce0':'MT','9e0':'AL','3e0':'AD','ae2':'IS','9e2':'LI','ce2':'LT','9e3':'LV','2e4':'EE','be2':'MC','de2':'RS','1e3':'ME','3e4':'MK','fe4':'BA','4e2':'VA','3e1':'SM','6e4':'UA','7e0':'RU','fe3':'BY','1e4':'MD','3e3':'TR'};
 return countries[gcc]||'unknown';
}
function groupMosaicStations(){
 const unique=new Map();
 for(const mux of library.multiplexes){
  const name=(mux.label||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
  const national=(Number(mux.ecc)===225&&[0xf043,0xf044].includes(Number(mux.eid)))||/^(?:metropolitain|m)\s*[12]$/.test(name);
  for(const station of mux.services||[]){
   const key=favoriteKey(station),country=mosaicCountry(station,mux);
   if(!unique.has(key))unique.set(key,{station,mux,country,national:false});
   const entry=unique.get(key);if(country==='FR'&&national)entry.national=true;
  }
 }
 const groups=new Map();
 const names=new Intl.DisplayNames(['fr'],{type:'region'});
 for(const entry of unique.values()){
  const id=entry.country==='FR'?(entry.national?'FR-national':'FR-local'):entry.country;
  const label=id==='FR-national'?'Fran\u00e7aises nationales':id==='FR-local'?'Fran\u00e7aises locales':id==='BE'?'Belges':id==='DE'?'Allemandes':id==='unknown'?'Pays non identifi\u00e9':names.of(id);
  if(!groups.has(id))groups.set(id,{id,label,stations:[]});
  groups.get(id).stations.push(entry);
 }
 const priority={'BE':0,'FR-national':1,'FR-local':2};
 return [...groups.values()].sort((a,b)=>(priority[a.id]??3)-(priority[b.id]??3)||a.label.localeCompare(b.label,'fr')).map(group=>{
  group.stations.sort((a,b)=>(a.station.label||'').trim().localeCompare((b.station.label||'').trim(),'fr',{sensitivity:'base',numeric:true}));return group;
 });
}

function bindLogoSearch(button,station){
 let timer,origin,suppress=false;
 const cancel=()=>{clearTimeout(timer);timer=null;};
 const open=()=>{cancel();suppress=true;openLogoSearch(station,Number(button.dataset.frequency));};
 button.addEventListener('pointerdown',e=>{if(e.button!==0)return;suppress=false;origin=[e.clientX,e.clientY];timer=setTimeout(open,650);});
 button.addEventListener('pointermove',e=>{if(origin&&Math.hypot(e.clientX-origin[0],e.clientY-origin[1])>10)cancel();});
 for(const event of ['pointerup','pointercancel','pointerleave'])button.addEventListener(event,cancel);
 button.addEventListener('click',e=>{if(suppress){e.preventDefault();e.stopImmediatePropagation();suppress=false;}},true);
 button.addEventListener('contextmenu',e=>{e.preventDefault();if(!suppress)open();});
 button.addEventListener('keydown',e=>{if(e.key==='F10'&&e.shiftKey){e.preventDefault();open();}});
 button.style.webkitTouchCallout='none';
}
function openLogoSearch(station,frequency){
 if(document.querySelector('.logo-picker'))return;
 const dialog=element('dialog','logo-picker');
 const header=element('div','logo-picker-header');
 const title=element('h2','',station.label||'La radio');
 const close=element('button','iconbutton','\u00d7');close.type='button';close.setAttribute('aria-label','Fermer');close.onclick=()=>dialog.close();
 const star=element('button','favorite-star logo-favorite');star.type='button';star.dataset.key=favoriteKey(station);star.dataset.label=station.label||'Radio';
 star.onclick=async()=>{star.disabled=true;try{await toggleFavorite(station,frequency||mosaicFrequencies(station)[0]||radio.frequencyKHz);}finally{star.disabled=false;}};
 header.append(title,star,close);
 const message=element('p','muted','Rechercher des logos sur RadioDNS, le site de la radio et Radio Browser.');message.setAttribute('role','status');
 const search=element('button','primary','Rechercher un logo');search.type='button';
 const grid=element('div','logo-picker-grid');
 const slideBox=element('div','logo-slide-choice');
 const slidePreview=element('img');slidePreview.alt='Slideshow actuel';slidePreview.hidden=true;
 const useSlide=element('button','secondary','Utiliser le slideshow actuel');useSlide.type='button';
 const hint=element('small','muted','Lance cette radio et attends son logo dans le slideshow.');
 slideBox.append(slidePreview,useSlide,hint);
 const currentSlide=()=>{
  const img=$('slide'),cur=radio.current||{};
  return !scan.active&&cur.playing&&favoriteKey(cur)===favoriteKey(station)&&!img.hidden&&img.complete&&img.naturalWidth>0&&img.dataset.broadcastSlide==='true'&&img.dataset.artworkOwner===[radio.frequencyKHz,Number(cur.sid),Number(cur.scids||0)].join(':')?img:null;
 };
 const refreshSlide=()=>{
  const img=currentSlide();useSlide.disabled=!img;
  slidePreview.hidden=!img;
  if(img&&slidePreview.dataset.source!==img.getAttribute('src')){
   // Capture the decoded pixels: the slideshow endpoint can change between requests.
   const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;canvas.getContext('2d').drawImage(img,0,0);
   slidePreview.src=canvas.toDataURL('image/png');slidePreview.dataset.source=img.getAttribute('src');
  }
 };
 useSlide.onclick=async()=>{
  const img=currentSlide();if(!img)return;
  useSlide.disabled=true;
  try{
   const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;canvas.getContext('2d').drawImage(img,0,0);
   await api('/api/logos/slideshow',{sid:station.sid,scids:station.scids||0,image:canvas.toDataURL('image/png').split(',')[1]});
   stationLogos=await api('/api/logos');serviceSignature='';librarySignature='';favoriteSignature='';manualStationsSignature='';mosaicSignature='';renderRadio();renderFavorites();renderMosaic();await loadLibrary();dialog.close();toast('Slideshow enregistr\u00e9 comme logo de la radio.');
  }catch(e){message.textContent=e.message;refreshSlide();}
 };
 dialog.append(header,message,search,slideBox,grid);document.body.append(dialog);
 refreshSlide();const slideTimer=setInterval(refreshSlide,1000);dialog.addEventListener('close',()=>clearInterval(slideTimer));
 dialog.addEventListener('close',()=>dialog.remove());dialog.showModal();updateFavoriteStars();loadFavorites().catch(()=>{});
 search.onclick=async()=>{
  search.disabled=true;grid.replaceChildren();message.textContent='Recherche en cours\u2026 Tu peux fermer cette fen\u00eatre sans interrompre la radio.';
  try{
   const {job}=await api('/api/logos/search',{sid:station.sid,scids:station.scids||0});
   const seen=new Set();
   while(dialog.open){
    const result=await api('/api/logos/status',{job});
    if(!dialog.open)return;
    for(const candidate of result.candidates){
     if(seen.has(candidate.url))continue;seen.add(candidate.url);
     const card=element('div','logo-choice');
     const choose=element('button','logo-choice-image');choose.type='button';choose.setAttribute('aria-label','Choisir ce logo : '+candidate.source);
     const img=element('img');img.src=candidate.url;img.alt=station.label||'Logo';choose.append(img);
     const source=element('a','muted',candidate.source);source.href=candidate.page;source.target='_blank';source.rel='noopener noreferrer';
     choose.onclick=async()=>{
      choose.disabled=true;
      try{await api('/api/logos/select',{job,url:candidate.url});stationLogos=await api('/api/logos');serviceSignature='';librarySignature='';favoriteSignature='';manualStationsSignature='';mosaicSignature='';renderRadio();renderFavorites();renderMosaic();await loadLibrary();dialog.close();toast('Logo enregistr\u00e9 pour tous les appareils.');}
      catch(e){message.textContent=e.message;choose.disabled=false;}
     };
     card.append(choose,source);grid.append(card);
    }
    if(result.done){message.textContent=seen.size?'Choisis le logo qui correspond \u00e0 cette radio.':'Aucun logo trouv\u00e9 pour cette radio.';if(result.errors.length)message.textContent+=' Certaines sources sont indisponibles : '+result.errors.join(', ')+'.';break;}
    await new Promise(resolve=>setTimeout(resolve,1000));
   }
  }catch(e){message.textContent=e.message;}
  finally{search.disabled=false;search.textContent='Relancer la recherche';}
 };
}

// Resume only a system-reported interruption, never an ordinary user pause.
async function resumeInterruptedPlayback(){
 if(!interruptedPlayback||!wantedAudio||interruptionResumeBusy||scan.active||busy||!radio.current?.playing||navigator.audioSession?.state==='interrupted')return;
 if(interruptionAttempts>=3)return;
 interruptionResumeBusy=true;interruptionAttempts++;
 try{
  if(audio.error||audio.ended||!audio.getAttribute('src'))audio.src='/stream/audio?_='+Date.now();
  await audio.play();
  if(!wantedAudio){audio.pause();return;}
  interruptedPlayback=false;interruptionAttempts=0;
 }catch{
  if(interruptionAttempts<3)setTimeout(resumeInterruptedPlayback,1500);
  else toast('La reprise automatique est bloqu\u00e9e par Safari. Utilise Lecture sur l\u2019autoradio ou l\u2019iPhone.');
 }finally{interruptionResumeBusy=false;playerUI();}
}
if(navigator.audioSession){
 try{navigator.audioSession.type='playback';}catch{}
 navigator.audioSession.addEventListener('statechange',()=>{
  if(navigator.audioSession.state==='interrupted'){
   if(wantedAudio&&!busy&&!scan.active){interruptedPlayback=true;interruptionAttempts=0;}
  }else resumeInterruptedPlayback();
 });
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&interruptedPlayback){interruptionAttempts=0;resumeInterruptedPlayback();}});
window.addEventListener('pageshow',()=>{if(interruptedPlayback){interruptionAttempts=0;resumeInterruptedPlayback();}});

function renderManualDetails(){
 const panel=$('manualDetails');panel.hidden=manualDetailFrequency===null;if(panel.hidden)return;
 const channel=channels.find(c=>Number(c.frequencyKHz)===manualDetailFrequency);
 text('manualDetailTitle','Canal '+(channel?.channel||''));
 text('manualDetailFrequency',number(manualDetailFrequency/1000,' MHz',3));
 const live=Number(radio.frequencyKHz)===manualDetailFrequency&&!scan.active;
 const rows=[];
 if(live)rows.push(element('p','',radio.syncLevel===2&&radio.ensemble?.valid?'En direct : '+radio.ensemble.label+' \u00b7 SNR '+number(radio.snr,' dB'):'En direct : recherche du signal \u00b7 SNR '+number(radio.snr,' dB')));
 const muxes=library.multiplexes.filter(m=>Number(m.frequencyKHz)===manualDetailFrequency).sort((a,b)=>String(b.lastSeen).localeCompare(String(a.lastSeen)));
 for(const m of muxes){
  const row=element('div','manual-mux-detail');row.append(element('strong','',m.label));
  const date=new Date(m.lastSeen);row.append(element('small','muted',[(m.services||[]).length+' stations','SNR '+number(m.snr,' dB'),Number.isNaN(date.getTime())?'':date.toLocaleString('fr-FR')].filter(Boolean).join(' \u00b7 ')));rows.push(row);
 }
 if(!muxes.length)rows.push(element('p','muted','Aucun multiplex m\u00e9moris\u00e9 sur ce canal.'));
 $('manualDetailMuxes').replaceChildren(...rows);
 $('manualDetailTune').disabled=busy||scan.active;
 $('manualDetailTune').textContent=live?'Recevoir ce canal \u00e0 nouveau':'Recevoir ce canal';
}
$('manualDetailTune').onclick=()=>{if(manualDetailFrequency!==null)selectStation(manualDetailFrequency);};
$('manualDetailClose').onclick=()=>{const f=manualDetailFrequency;manualDetailFrequency=null;renderManual();document.querySelector('.manual-bar[data-frequency="'+f+'"]')?.focus({preventScroll:true});};

$('expandedFavorite').onclick=async()=>{
 if(busy||scan.active||favoritesBusy||!radio.current?.playing)return;
 const current={...radio.current},frequency=radio.frequencyKHz;
 const station=(radio.services||[]).find(s=>favoriteKey(s)===favoriteKey(current))||current;
 $('expandedFavorite').disabled=true;
 try{await toggleFavorite(station,frequency);}finally{updateControls();}
};

function renderTechnical(connected=true){
 const a=radio.advanced||{},c=radio.current||{},e=radio.ensemble||{},d=a.decodingStats||{};
 const live=connected&&!scan.active&&radio.syncLevel===2;
 const service=live&&c.playing;
 renderTechnicalMeters(live,service,a,d);
 const value=(v,unit='')=>typeof v==='number'&&Number.isFinite(v)?number(v,unit):'—';
 const count=v=>Number.isFinite(v)?v.toLocaleString('fr-FR'):'—';
 const hex=v=>v!==undefined&&v!==null&&Number.isFinite(Number(v))?'0x'+Number(v).toString(16).toUpperCase():'—';
 const rows=(id,items)=>{$(id).replaceChildren(...items.flatMap(([label,val])=>[element('dt','',label),element('dd','',String(val))]));};
 text('techContext',connected?[e.valid?e.label:null,radio.channel?'Canal '+radio.channel:null,c.playing?c.label:null].filter(Boolean).join(' · ')||'En attente de réception':'Connexion au serveur perdue');
 text('techAvailability',!connected?'Les mesures sont indisponibles.':scan.active?'Scan en cours : les statistiques du service sont suspendues.':!live?'En attente de synchronisation : les compteurs de décodage sont masqués.':'Actualisation automatique pendant la réception.');
 rows('techReception',[
 ['Synchronisation',!connected?'Indisponible':radio.syncLevel===2?'Complète':radio.syncLevel===1?'Partielle':'Non synchronisé'],
 ['SNR',connected?value(radio.snr,' dB'):'—'],['Niveau RF (indicatif)',connected?value(a.rfLevel,' dB'):'—'],['Gain mesuré',connected?value(a.gain,' dB'):'—'],['Décalage en fréquence',live?value(a.freqOffsetHz,' Hz'):'—']]);
 rows('techDecoding',[
 ['Blocs FIB attendus',live?count(d.fibCntr):'—'],['Blocs FIB erronés',live?count(d.fibErrorCntr):'—'],
 ['MSC : CRC valides',service?count(d.mscCrcOkCntr):'—'],['MSC : erreurs CRC',service?count(d.mscCrcErrorCntr):'—'],['RS : erreurs de bits signalées',service?count(d.rsBitErrorCntr):'—'],['RS : non corrigeables',service?count(d.rsUncorrectableCntr):'—']]);
 const au=c.audio||{};
 rows('techAudio',[
 ['Débit',service?value(a.bitRate,' kbit/s'):'—'],['Échantillonnage',service?value(au.sampleRate/1000,' kHz'):'—'],['Canaux',service&&typeof au.stereo==='boolean'?(au.stereo?'Stéréo':'Mono'):'—'],['SBR',service&&typeof au.sbr==='boolean'?(au.sbr?'Actif':'Inactif'):'—'],['Stéréo paramétrique',service&&typeof au.parametricStereo==='boolean'?(au.parametricStereo?'Active':'Inactive'):'—'],['Données audio / PAD (octets)',service?count(d.audioServiceBytes)+' / '+count(d.padBytes):'—']]);
 rows('techIdentity',[
 ['Fréquence',connected?value(radio.frequencyKHz/1000,' MHz'):'—'],['EID / ECC',live&&e.valid?hex(e.eid)+' / '+hex(e.ecc):'—'],['SID',service?hex(c.sid):'—'],['Composante SCIdS',service?count(c.scids):'—'],['Sous-canal',service?count(a.subChId):'—'],['Taille du sous-canal (CU)',service?count(a.subChSize):'—']]);
}

function technicalPercent(good,total){
 return Number.isFinite(good)&&Number.isFinite(total)&&total>0&&good>=0&&good<=total?100*good/total:null;
}
function renderTechnicalMeters(live,service,a,d){
 const fic=live?technicalPercent(d.fibCntr-d.fibErrorCntr,d.fibCntr):null;
 const msc=service?technicalPercent(d.mscCrcOkCntr,d.mscCrcOkCntr+d.mscCrcErrorCntr):null;
 const snr=live&&Number.isFinite(radio.snr)?radio.snr:null;
 const items=[['SNR',snr,30,' dB','0 — 30 dB',snr>=12?'good':snr>=6?'fair':'poor'],
 ['FIC valide',fic,100,' %','Blocs FIB sans erreur CRC',fic===100?'good':fic>=95?'fair':'poor'],
 ['MSC valide',msc,100,' %','CRC valides du service (après RS en DAB+)',msc===100?'good':msc>=95?'fair':'poor']];
 const nodes=items.map(([label,v,max,unit,note,quality])=>{
  const card=element('article','tech-meter');card.dataset.quality=v===null?'unknown':quality;
  const heading=element('div','tech-meter-heading');heading.append(element('h2','',label),element('strong','',v===null?'Indisponible':number(v,unit)));
  const bar=element('div','tech-meter-track');bar.setAttribute('role','meter');bar.setAttribute('aria-label',label);bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax',String(max));
  if(v!==null){bar.setAttribute('aria-valuenow',String(Math.max(0,Math.min(max,v))));bar.setAttribute('aria-valuetext',number(v,unit));}else{bar.removeAttribute('role');bar.setAttribute('aria-label',label+' : indisponible');}
  const fill=element('span','');fill.style.width=(v===null?0:Math.max(0,Math.min(100,v/max*100)))+'%';bar.append(fill);
  card.append(heading,bar,element('small','muted',note));return card;
 });
 const offset=live&&Number.isFinite(a.freqOffsetHz)?a.freqOffsetHz:null;
 const card=element('article','tech-meter');const heading=element('div','tech-meter-heading');heading.append(element('h2','','Décalage fréquence'),element('strong','',offset===null?'Indisponible':number(offset,' Hz',0)));
 const track=element('div','tech-offset');track.setAttribute('aria-hidden','true');if(offset!==null){const marker=element('span','');marker.style.left=Math.max(0,Math.min(100,50+offset/20))+'%';track.append(marker);}
 card.append(heading,track,element('small','muted','−1 000 Hz · 0 · +1 000 Hz (jauge bornée)'));nodes.push(card);
 const errors=service&&Number.isFinite(d.rsUncorrectableCntr)?d.rsUncorrectableCntr:null;
 const rs=element('article','tech-meter');rs.dataset.quality=errors===null?'unknown':errors===0?'good':'poor';const rh=element('div','tech-meter-heading');rh.append(element('h2','','RS non corrigeables'),element('strong','',errors===null?'Indisponible':String(errors)));rs.append(rh,element('small','muted','Mots de code non corrigés sur la dernière période'));nodes.push(rs);
 $('techMeters').replaceChildren(...nodes);
}
