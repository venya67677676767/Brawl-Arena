// BRAWL ARENA — онлайн-патч: PWA + матчмейкинг с ботами + Босс-файт Кицунэ + сундучок Кицунэ + автообновление.
// Подключается в конце index.html, ничего не ломает: все хуки через try/catch и проверку типов.
(function(){
'use strict';
const $ = id => document.getElementById(id);
const APP_VERSION = '1.1.0';

/* ---------- 1) PWA: установка как приложение ---------- */
try {
  if ('serviceWorker' in navigator && /^https?:|^http:\/\/localhost/.test(location.href)) {
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  }
} catch(e){}

/* ---------- 2) Автообновление без нового файла ---------- */
async function checkUpdate(silent){
  try {
    const r = await fetch('./version.json?ts='+Date.now(), {cache:'no-store'});
    if(!r.ok) return;
    const v = await r.json();
    const cur = localStorage.getItem('brawlAppVersion') || APP_VERSION;
    if (v.version && v.version !== cur) {
      localStorage.setItem('brawlAppVersion', v.version);
      if ('caches' in window) { try { const ks = await caches.keys(); await Promise.all(ks.map(k=>caches.delete(k))); } catch(e){} }
      if (!silent) toast('🌸 Вышло обновление ' + v.version + '! Перезагружаю…');
      setTimeout(()=>location.reload(true), silent ? 0 : 1500);
      return true;
    }
    localStorage.setItem('brawlAppVersion', cur);
  } catch(e){}
  return false;
}
setTimeout(()=>checkUpdate(true), 4000);
setInterval(()=>checkUpdate(true), 5*60*1000);
window.checkGameUpdate = () => checkUpdate(false);

function toast(msg){
  try {
    let t = $('onlineToast');
    if(!t){ t = document.createElement('div'); t.id='onlineToast';
      t.style.cssText='position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;background:#101a2dee;border:2px solid #ffd342;border-radius:14px;padding:10px 16px;font-weight:900;color:#fff;max-width:92vw;text-align:center';
      document.body.appendChild(t);
    }
    t.textContent = msg; t.style.display='block';
    clearTimeout(t._h); t._h=setTimeout(()=>t.style.display='none', 3500);
  } catch(e){}
}

/* ---------- 3) Кнопка "Скачать / Установить как приложение" ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; paintInstallBtn(); });
function paintInstallBtn(){
  try {
    if ($('installAppBtn')) { $('installAppBtn').style.display = deferredPrompt ? '' : 'none'; return; }
    const b = document.createElement('button');
    b.id='installAppBtn'; b.className='mini'; b.style.display = deferredPrompt ? '' : 'none';
    b.textContent = '📲 Скачать как приложение';
    b.onclick = async () => {
      if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice.catch(()=>{}); deferredPrompt=null; paintInstallBtn(); }
      else toast('Открой игру в Chrome → ⋮ → «Установить приложение» / «Добавить на главный экран». Дальше обновления придут сами, скачивать заново не нужно.');
    };
    const top = document.querySelector('#lobby');
    if (top) top.insertBefore(b, top.firstChild);
  } catch(e){}
}
setTimeout(paintInstallBtn, 1500);
setTimeout(()=>{ if(!$('installAppBtn')) paintInstallBtn(); }, 4000);

/* ---------- 4) Онлайн-статус + матчмейкинг: ищем живых, иначе боты ---------- */
function isOnlineMode(){ try { return typeof ONLINE!=='undefined' && ONLINE; } catch(e){ return false; } }

const _origStart = (typeof startGame==='function') ? startGame : null;
async function onlineFind(mode, need){
  // Серверный быстрый подбор: POST api/find {mode}. Если сервера нет — сразу null (боты).
  try {
    const r = await fetch('api/find', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({token: (typeof TOKEN!=='undefined'?TOKEN:''), mode})});
    if(!r.ok) return null;
    return await r.json();
  } catch(e){ return null; }
}

async function startWithMatchmaking(){
  // Вызывается вместо прямого startGame для соло-очередей.
  const mode = (typeof gmode!=='undefined') ? gmode : 'team';
  const soloLike = ['ffa','arena','team','ball','trio','duo','moba'].includes(mode);
  if (!isOnlineMode() || !soloLike || (typeof partyInfo!=='undefined' && partyInfo)) {
    return _origStart ? _origStart() : null;
  }
  try {
    if ($('matchintro')) {
      $('matchintro').style.display='flex';
      if($('introtitle')) $('introtitle').textContent='ПОИСК ИГРОКОВ';
      if($('introsub')) $('introsub').textContent='Ищем живых игроков в этот режим…';
      if($('introhint')) $('introhint').textContent='Если никого нет онлайн — подберём ботов';
    }
  } catch(e){}
  const t0 = Date.now();
  let found = null;
  // 3 попытки за ~6 секунд
  for (let i=0;i<3;i++){
    found = await onlineFind(mode, 1);
    if (found && found.matched && found.matched.length) break;
    await new Promise(r=>setTimeout(r, 2000));
    if (Date.now()-t0 > 6500) break;
  }
  try { if ($('matchintro') && !(found&&found.matched&&found.matched.length)) {
    if($('introsub')) $('introsub').textContent='Живых игроков нет — запускаем катку с ботами 🤖';
    await new Promise(r=>setTimeout(r, 900));
  }} catch(e){}
  // Если сервер подобрал живых — он сам создал пати и пришлёт событие match; просто ждём.
  if (found && found.matched && found.matched.length) {
    toast('👥 Нашли игроков! Запускаем онлайн-катку…');
    try { if ($('matchintro')) $('matchintro').style.display='none'; } catch(e){}
    return; // событие onMatch запустит бой у всех
  }
  return _origStart ? _origStart() : null;
}

// Перехватываем клики по режимам: идём через матчмейкинг
setTimeout(()=>{
  try {
    document.querySelectorAll('.modebtn').forEach(b=>{
      if (b.dataset.mmHooked) return; b.dataset.mmHooked='1';
      const old = b.onclick;
      b.onclick = (e)=>{ try{ gmode = b.dataset.mode; }catch(_){}
        if($('modes')) $('modes').style.display='none';
        if (b.dataset.mode==='boss') { return startBossFight(); }
        return startWithMatchmaking();
      };
    });
  } catch(e){}
}, 1200);

/* ---------- 5) БОСС-ФАЙТ: большая сакура-карта + коробки + большая Кицунэ ---------- */
function ensureBossButton(){
  try {
    const grid = document.querySelector('.modegrid');
    if (!grid || grid.querySelector('[data-mode="boss"]')) return;
    const b = document.createElement('button');
    b.className='modebtn'; b.dataset.mode='boss';
    b.innerHTML = '<div class="mode-art">🦊</div><div class="mode-name">🦊 БОСС-ФАЙТ · КИЦУНЭ</div><div class="small">4 тиммейта против огромной Кицунэ. Сакура-арена, коробки с усилениями. Каждые 2 победы — сундучок Кицунэ!</div>';
    b.onclick = ()=>{ try{ gmode='boss'; }catch(e){} if($('modes')) $('modes').style.display='none'; startBossFight(); };
    grid.appendChild(b);
  } catch(e){}
}
setTimeout(ensureBossButton, 800);
setInterval(ensureBossButton, 5000);

function startBossFight(){
  try {
    if (typeof partyInfo!=='undefined' && partyInfo && isOnlineMode()) {
      // В пати босса считает хост, остальные — гости (штатный механизм).
      if (partyInfo.leader !== (typeof acct!=='undefined'?acct:'')) { toast('Бой начинает хозяин лобби 👑'); return; }
      fetch('api/start',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token:(typeof TOKEN!=='undefined'?TOKEN:''), mode:'boss'})}).catch(()=>{});
      return;
    }
    // Оффлайн / соло: локальный бой с ботами-тиммейтами
    gmode = 'boss';
    if($('modes')) $('modes').style.display='none';
    _origStart ? _origStart() : null;
    setTimeout(setupBossArena, 60);
  } catch(e){ try{ _origStart(); }catch(_){} }
}
window.startBossFight = startBossFight;

let bossTick = null;
function setupBossArena(){
  try {
    if ((typeof gmode==='undefined' ? '' : gmode) !== 'boss') return;
    // 4 тиммейта (ты + 3 бота) против 1 босса:
    // resetGame уже создал ботов; переделываем их в союзников + босса.
    if (typeof bots==='undefined' || typeof player==='undefined') return;
    const kit = (typeof roster!=='undefined') ? (roster.find(x=>x.id==='kitsune')||roster[0]) : null;
    // Чистим лишних, оставляем 3 союзников
    bots.length = 0;
    const F = (typeof selected==='function') ? selected() : (kit||{});
    for (let i=0;i<3;i++){
      const bf = (typeof roster!=='undefined') ? roster[Math.floor(Math.random()*roster.length)] : F;
      bots.push({team:0, x:(typeof ARENA!=='undefined'?ARENA.cx:3000)+[-140,0,140][i], y:(typeof ARENA!=='undefined'?ARENA.cy:3000)+220,
        r:bf.r||22, hp:(bf.hp||110)*1.1, maxHp:(bf.hp||110)*1.1, speed:(bf.speed||230)*.85,
        damage:(bf.atk&&bf.atk.dmg)||15, atk:bf.atk||F.atk, cd:Math.random(), angle:-Math.PI/2,
        color:['#3d9bff','#54f28a','#c38bff'][i], fighterId:bf.id||'rookie', fighterName:'🤝 '+(bf.name||'Союзник'),
        charge:0, rapid:0, stun:0, invis:0, shield:0, vx:0, vy:0, ammo:3, maxAmmo:3, reloadLeft:0,
        attackAnim:0, strafe:1, path:null, pi:0, repath:0, sup:0});
    }
    // БОСС: большая Кицунэ
    const bossHp = 9000;
    const boss = {team:1, isBoss:true, x:(typeof ARENA!=='undefined'?ARENA.cx:3000), y:(typeof ARENA!=='undefined'?ARENA.cy:3000)-320,
      r:64, hp:bossHp, maxHp:bossHp, speed:170, damage:30,
      atk: kit?kit.atk:{kind:'feather',dmg:25}, cd:0, angle:Math.PI/2, color:'#ff9b3d',
      fighterId:'kitsune', fighterName:'🦊 ВЕЛИКАЯ КИЦУНЭ · БОСС', charge:100, rapid:0, stun:0, invis:0, shield:0,
      vx:0, vy:0, ammo:99, maxAmmo:99, reloadLeft:0, attackAnim:0, strafe:1, path:null, pi:0, repath:0, sup:0, bossT:0};
    bots.push(boss);
    try {
      player.team = 0;
      if ($('lefttxt')) $('lefttxt').textContent = '🦊 Победи Великую Кицунэ!';
      if ($('help')) $('help').textContent = 'Босс-файт: уворачивайся от печатей и колец пламени, бей коробочки ради усилений!';
    } catch(e){}
    // Коробки с усилениями: накидываем много бустов по сакура-арене
    try {
      if (typeof boosts!=='undefined') {
        for (let i=0;i<14;i++) boosts.push({x:(ARENA.cx-500+Math.random()*1000), y:(ARENA.cy-500+Math.random()*1000), r:14, alive:true, sakura:true});
      }
    } catch(e){}
    toast('🦊 БОСС-ФАЙТ: 4 против Великой Кицунэ!');
    if (bossTick) clearInterval(bossTick);
    bossTick = setInterval(bossLogic, 900);
  } catch(e){}
}

function bossLogic(){
  try {
    if ((typeof running==='undefined'||!running) || gmode!=='boss') return;
    const boss = (typeof bots!=='undefined') ? bots.find(b=>b.isBoss && b.hp>0) : null;
    if (!boss) return;
    boss.bossT = (boss.bossT||0)+1;
    // Особые большие атаки Кицунэ (похожи на её атаки, но больше):
    if (typeof useSuper==='function' && boss.charge>=100) { try{ useSuper(boss); }catch(e){} boss.charge=100; }
    else boss.charge = 100;
    // Каждые ~4 сек: большое кольцо пламени + веер печатей
    if (boss.bossT % 4 === 0 && typeof bullets!=='undefined' && typeof player!=='undefined') {
      const a = Math.atan2(player.y-boss.y, player.x-boss.x);
      for (let i=0;i<12;i++){ const an=a+i*Math.PI*2/12;
        bullets.push({x:boss.x+Math.cos(an)*boss.r, y:boss.y+Math.sin(an)*boss.r,
          vx:Math.cos(an)*380, vy:Math.sin(an)*380, r:11, life:1.6, owner:'bot', shooter:boss,
          damage:22, color:'#ff7a2e', kind:'feather'});
      }
      if (typeof fx!=='undefined') fx.push({x:boss.x,y:boss.y,r:0,max:260,c:'#ffb36b',t:.5,life:.5});
    }
    // Босс потихоньку лечится, если его долго не бьют — держит темп боя
    if (boss.bossT % 10 === 0 && boss.hp < boss.maxHp*0.5) boss.hp = Math.min(boss.maxHp, boss.hp + boss.maxHp*0.03);
    try { if ($('lefttxt')) $('lefttxt').textContent = '🦊 Кицунэ: ' + Math.max(0,Math.ceil(boss.hp)) + ' HP · Союзников: ' + bots.filter(b=>!b.isBoss&&b.hp>0).length; } catch(e){}
  } catch(e){}
}

// Победа над боссом → сундучок Кицунэ каждые 2 победы
const _origEnd = (typeof end==='function') ? end : null;
if (_origEnd) {
  end = function(win){
    const wasBoss = (typeof gmode!=='undefined' && gmode==='boss');
    if (bossTick && (!wasBoss || win===true || win===false)) { try{clearInterval(bossTick);}catch(e){} bossTick=null; }
    _origEnd.apply(this, arguments);
    if (!wasBoss) return;
    try {
      if (win === true) {
        save.bossWins = (save.bossWins||0)+1;
        if (typeof persist==='function') persist();
        if ((save.bossWins||0) % 2 === 0) setTimeout(openKitsuneChest, 900);
        else toast('🦊 Победа над Кицунэ! (' + save.bossWins + ') Ещё ' + (2 - (save.bossWins%2)) + ' — и сундучок Кицунэ!');
      }
    } catch(e){}
  };
}

function hasFighter(id){
  try {
    if (save.unlocked && save.unlocked.includes(id)) return true;
    if (typeof roster!=='undefined'){ const f=roster.find(x=>x.id===id); if(f && !f.trophy) return true; }
    return (save.credits||0) >= 0 && (save.unlocked||[]).includes(id);
  } catch(e){ return false; }
}
function unlockFighter(id){
  try { save.unlocked = save.unlocked||[]; if(!save.unlocked.includes(id)) save.unlocked.push(id); if(typeof persist==='function') persist(); } catch(e){}
}

function openKitsuneChest(){
  try {
    const roll = Math.random()*100;
    let title='🦊 СУНДУЧОК КИЦУНЭ', html='', desc='Награда за 2 победы над Великой Кицунэ!';
    const hasKit = (function(){ try{
      if (save.unlocked && save.unlocked.includes('kitsune')) return true;
      // kitsune может быть уже открыта через кредиты
      return (typeof creditOwned==='function') ? creditOwned('kitsune') : (save.unlocked||[]).includes('kitsune');
    }catch(e){ return (save.unlocked||[]).includes('kitsune'); } })();
    if (roll < 7.5) { // 5–10%
      if (!hasKit) { unlockFighter('kitsune'); html='<div class="rewardpop">🦊 КИЦУНЭ!</div><div class="tag">Ультралегендарный боец</div>'; desc='Тебе выпала Кицунэ — редчайший боец сакуры!'; }
      else { save.credits=(save.credits||0)+2000; html='<div class="rewardpop">+2000 🟩</div><div class="tag">Кредиты (Кицунэ уже есть)</div>'; }
    } else if (roll < 32.5) { // ~20–30%
      const pool = (typeof roster!=='undefined'?roster:[]).filter(f=>f.id!=='kitsune');
      const f = pool.length?pool[Math.floor(Math.random()*pool.length)]:{id:'rookie',name:'Рокки'};
      let skinId = null, skinName = 'Сакура';
      try {
        const list = (typeof getFighterSkins==='function') ? getFighterSkins(f.id) : [];
        const sak = list.find(s=>/sakura/i.test(s.id||'')||/Сакура/i.test(s.name||'')) || list[1] || list[0];
        if (sak) { skinId = sak.id; skinName = sak.name; }
      } catch(e){}
      if (!skinId) skinId = f.id + '_sakura';
      save.skins = save.skins||[]; if(!save.skins.includes(skinId)) save.skins.push(skinId);
      html='<div class="rewardpop">🌸 Сакура-скин</div><div class="tag">'+(f.name||f.id)+' · '+skinName+'</div>';
      desc='Сакура-скин выпал, даже если бойца пока нет — скин дождётся своего героя! Выбери его в карточке бойца.';
    } else {
      const coins = 150+Math.floor(Math.random()*150), gems = 10+Math.floor(Math.random()*15);
      save.coins=(save.coins||0)+coins; save.gems=(save.gems||0)+gems;
      html='<div class="rewardpop">+'+coins+' 🪙 · +'+gems+' 💎</div>';
    }
    if (typeof persist==='function') persist();
    if (typeof showModal==='function') showModal({title, visual:'🦊', reward:html, desc, btn:'ЗАБРАТЬ', onBtn:()=>{ try{hideModal()}catch(e){} }});
    else toast(title+': '+desc);
  } catch(e){}
}
window.openKitsuneChest = openKitsuneChest;

/* ---------- 6) Подсказка про сервер, если его нет ---------- */
setTimeout(async ()=>{
  if (isOnlineMode()) { toast('🟢 Сервер подключён: аккаунты, друзья и лобби работают онлайн'); return; }
  // Оффлайн-режим игры уже работает (аккаунты в браузере). Сервер нужен для игры с других устройств.
  try {
    const b = document.createElement('button');
    b.className='mini'; b.textContent='🖥 Как включить общий онлайн-сервер?';
    b.style.margin='6px auto'; b.style.display='block';
    b.onclick = ()=>{ if(typeof showModal==='function') showModal({title:'Общий сервер', visual:'🖥',
      desc:'Сейчас игра работает БЕЗ сервера: аккаунты хранятся на этом устройстве, друзья — по никам на этом устройстве, а «онлайн» — это умные боты.<br><br>Чтобы друзья с ДРУГИХ телефонов видели тебя и играли с тобой:<br>1) Открой папку server<br>2) Запусти: node server.js<br>3) Открой http://ТВОЙ-IP:3000<br><br>Подробно — в файле README и КАК_ЗАПУСТИТЬ.txt',
      btn:'ПОНЯТНО', onBtn:()=>{try{hideModal()}catch(e){}}}); };
    const lobby = $('lobby'); if (lobby && !$('srvHelpBtn')) { b.id='srvHelpBtn'; lobby.appendChild(b); }
  } catch(e){}
}, 2500);

})();
