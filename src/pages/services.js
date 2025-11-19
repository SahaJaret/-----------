import { fileURLToPath } from 'url';
export function renderServicesPage(pass, csrf, CONFIG, KEY_BACKEND){
  return `
    <header class="glass border-b border-slate-800/50 px-6 py-5 sticky top-0 z-10">
      <div>
        <h1 class="text-2xl md:text-3xl font-semibold tracking-tight mb-1">Services</h1>
        <p class="text-sm text-slate-400">Manage external integrations</p>
      </div>
    </header>

    <div class="p-6 space-y-6">
      <!-- Work.ink Service -->
      <div class="glass rounded-xl p-6">
        <div class="flex items-start gap-4 mb-6">
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-500 to-pink-600 flex items-center justify-center shadow-lg shadow-purple-500/30">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/>
            </svg>
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-3 mb-2">
              <h2 class="text-xl font-bold">Work.ink</h2>
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Active</span>
            </div>
            <p class="text-slate-400 text-sm mb-4">Monetization service for key generation</p>
            
        <div class="space-y-3">
          <form method="POST" action="/admin/update-config" class="glass rounded-lg p-4 border border-slate-700/50 space-y-2">
            <input type="hidden" name="pass" value="${pass}">
            <input type="hidden" name="csrf" value="${csrf}">
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Backend Base URL (domain)</label>
            <div class="flex gap-2">
              <input name="KEY_BACKEND" type="text" value="${KEY_BACKEND}" class="input font-mono flex-1">
              <button type="button" onclick="navigator.clipboard.writeText(document.querySelector('[name=KEY_BACKEND]').value)" class="btn btn-outline-blue">Copy</button>
            </div>
            <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Work.ink URL</label>
            <div class="flex gap-2">
              <input name="WORKINK_LINK" type="text" value="${CONFIG.WORKINK_LINK}" class="input font-mono flex-1">
              <button type="button" onclick="navigator.clipboard.writeText(document.querySelector('[name=WORKINK_LINK]').value)" class="btn btn-outline-blue">Copy</button>
            </div>
            <div class="mt-3">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">YouTube Channel URL</label>
              <input name="YT_CHANNEL" type="text" value="${CONFIG.YT_CHANNEL}" class="input font-mono w-full">
            </div>
            <div class="mt-3">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Discord Webhook URL</label>
              <input name="DISCORD_WEBHOOK_URL" type="text" value="${CONFIG.DISCORD_WEBHOOK_URL}" class="input font-mono w-full">
            </div>
            <div class="mt-3">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Verification Steps</label>
              <div class="glass rounded-xl p-4 border border-slate-700/30 space-y-3">
                <div class="flex items-center justify-between">
                  <div class="text-sm text-slate-400">Шаги верификации</div>
                  <button type="button" id="add-step" class="btn btn-outline-blue btn-sm">Добавить шаг</button>
                </div>
                <div id="steps-canvas" class="space-y-3"></div>
              </div>
              <input type="hidden" name="CHECKPOINTS_JSON" id="CHECKPOINTS_JSON" value="[]">
              <script type="text/javascript">
                (function(){
                  var canvas = document.getElementById('steps-canvas');
                  var addBtn = document.getElementById('add-step');
                  var hidden = document.getElementById('CHECKPOINTS_JSON');
                  var initial = ${JSON.stringify(CONFIG.CHECKPOINTS || [])};
                  var steps = Array.isArray(initial) ? initial.slice(0,20) : [];
                  steps = steps.map(function(s){
                    if (!s) return { kind:'group', mode:'any', name:'', description:'', items: [] };
                    if (s.kind === 'group') { s.mode = (s.mode === 'all') ? 'all' : 'any'; s.items = Array.isArray(s.items) ? s.items : []; return s; }
                    return { kind:'group', mode:(s.mode==='all'?'all':'any'), name:(s.name||''), description:(s.description||''), items:[{ type:(s.type||'link'), label:(s.label||'Open Link'), url:(s.url||''), duration:(s.duration||0) }] };
                  });
                  function updateHidden(){ hidden.value = JSON.stringify(steps); }
                  function makeInput(value, placeholder, onChange){ var i=document.createElement('input'); i.type='text'; i.className='input w-full'; i.value=value||''; i.placeholder=placeholder||''; i.addEventListener('input', function(){ onChange(i.value); updateHidden(); }); return i; }
                  function makeNumber(value, onChange){ var i=document.createElement('input'); i.type='number'; i.min='0'; i.className='input w-24'; i.value=String(value||0); i.addEventListener('input', function(){ var v=parseInt(i.value)||0; onChange(v); updateHidden(); }); return i; }
                  function makeSelect(options, value, onChange){ var s=document.createElement('select'); s.className='input'; options.forEach(function(opt){ var o=document.createElement('option'); o.value=opt.value; o.text=opt.text; s.appendChild(o); }); s.value=value; s.addEventListener('change', function(){ onChange(s.value); updateHidden(); }); return s; }
                  function render(){ while(canvas.firstChild) canvas.removeChild(canvas.firstChild); if(!steps.length){ var empty=document.createElement('div'); empty.className='text-center text-slate-400 py-8'; empty.textContent='Нет шагов'; canvas.appendChild(empty); updateHidden(); return; } steps.forEach(function(step, idx){ var card=document.createElement('div'); card.className='glass rounded-lg p-4 border border-slate-700/30 space-y-3'; var header=document.createElement('div'); header.className='flex items-center justify-between'; var left=document.createElement('div'); left.className='flex items-center gap-2'; var nameInput=makeInput(step.name, 'Название шага', function(v){ step.name=v; }); left.appendChild(nameInput); var modeSel=makeSelect([{value:'all',text:'Требуются все'},{value:'any',text:'Любой один'}], step.mode, function(v){ step.mode=v; }); left.appendChild(modeSel); header.appendChild(left); var del=document.createElement('button'); del.className='btn btn-outline-rose btn-sm'; del.textContent='Удалить шаг'; del.addEventListener('click', function(){ steps.splice(idx,1); render(); }); header.appendChild(del); card.appendChild(header); var info=document.createElement('div'); info.className='text-xs text-slate-400'; info.textContent=String((step.items||[]).length)+' пункт(ов) • '+(step.mode==='all'?'требуются все':'любой один'); card.appendChild(info); var descInput=makeInput(step.description, 'Описание (необязательно)', function(v){ step.description=v; }); card.appendChild(descInput); var itemsWrap=document.createElement('div'); itemsWrap.className='space-y-2'; (step.items||[]).forEach(function(item, ii){ var row=document.createElement('div'); row.className='flex items-center gap-2'; var typeSel=makeSelect([{value:'youtube',text:'YouTube'},{value:'discord',text:'Discord'},{value:'workink',text:'Work.ink'},{value:'lootlab',text:'LootLab'},{value:'linkverse',text:'Linkverse'},{value:'link',text:'Link'}], item.type||'link', function(v){ item.type=v; }); var labelInput=makeInput(item.label, 'Название', function(v){ item.label=v; }); var urlInput=makeInput(item.url, 'Ссылка', function(v){ item.url=v; }); var durInput=makeNumber(item.duration||0, function(v){ item.duration=v; }); var delItem=document.createElement('button'); delItem.className='btn btn-outline-rose btn-sm'; delItem.textContent='Удалить'; delItem.addEventListener('click', function(){ step.items.splice(ii,1); render(); }); row.appendChild(typeSel); row.appendChild(labelInput); row.appendChild(urlInput); row.appendChild(durInput); row.appendChild(delItem); itemsWrap.appendChild(row); }); var addItem=document.createElement('button'); addItem.className='btn btn-outline-blue btn-sm'; addItem.textContent='Добавить пункт'; addItem.addEventListener('click', function(){ step.items = step.items || []; step.items.push({ type:'link', label:'Open Link', url:'https://example.com', duration:0 }); render(); }); card.appendChild(itemsWrap); card.appendChild(addItem); canvas.appendChild(card); }); updateHidden(); }
                  if (addBtn) { addBtn.addEventListener('click', function(){ steps.push({ kind:'group', mode:'any', name:'New Step', description:'', items: [] }); render(); }); }
                  render();
                })();
              </script>
            </div>
          </form>
        </div>
          </div>
        </div>
      </div>

      <!-- YouTube Service -->
      <div class="glass rounded-xl p-6">
        <div class="flex items-start gap-4 mb-6">
          <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-red-500 to-pink-600 flex items-center justify-center shadow-lg shadow-red-500/30">
            <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M21.8 8s-.2-1.5-.8-2.2c-.8-.8-1.6-.8-2-.9C15.8 4.7 12 4.7 12 4.7s-3.8 0-7 .2c-.4 0-1.2.1-2 .9C2.3 6.5 2.2 8 2.2 8S2 9.6 2 11.3v1.3C2 14.3 2.2 16 2.2 16s.2 1.5.8 2.2c.8.8 1.6.8 2 .9 1.4.1 7 .2 7 .2s3.8 0 7-.2c.4-.1 1.2-.1 2-.9.6-.7.8-2.2.8-2.2s.2-1.7.2-3.4V11.3C22 9.6 21.8 8 21.8 8zM10 14.7V9.3l5.3 2.7L10 14.7z"/>
            </svg>
          </div>
          <div class="flex-1">
            <div class="flex items-center gap-3 mb-2">
              <h2 class="text-xl font-bold">YouTube Checkpoint</h2>
              <span class="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Active</span>
            </div>
            <p class="text-slate-400 text-sm mb-4">First verification step before Work.ink</p>
            
            <div class="glass rounded-lg p-4 border border-slate-700/50">
              <label class="block text-xs text-slate-400 mb-2 uppercase tracking-wider">Channel URL</label>
              <div class="flex gap-2">
                <input type="text" value="${CONFIG.YT_CHANNEL}" readonly class="flex-1 bg-slate-950/40 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono">
                <a href="${CONFIG.YT_CHANNEL}" target="_blank" class="btn btn-outline-red">Open</a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- API Endpoints -->
      <div class="glass rounded-xl p-6">
        <div class="mb-6">
          <h2 class="text-xl font-bold mb-2">API Endpoints</h2>
          <p class="text-slate-400 text-sm">Available endpoints for integration</p>
        </div>

        <div class="space-y-3">
          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-300">GET</span>
                <code class="text-sm font-mono text-slate-200">/gate</code>
              </div>
              <p class="text-xs text-slate-400">Get key generation URL</p>
            </div>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-300">GET</span>
                <code class="text-sm font-mono text-slate-200">/check</code>
              </div>
              <p class="text-xs text-slate-400">Verify key validity (for Roblox scripts)</p>
            </div>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-300">GET</span>
                <code class="text-sm font-mono text-slate-200">/get-key</code>
              </div>
              <p class="text-xs text-slate-400">User checkpoint page (YouTube verification)</p>
            </div>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-blue-500/10 text-blue-300">POST</span>
                <code class="text-sm font-mono text-slate-200">/yt-done</code>
              </div>
              <p class="text-xs text-slate-400">YouTube checkpoint completion</p>
            </div>
          </div>

          <div class="flex items-center justify-between p-4 glass rounded-lg border border-slate-700/50">
            <div class="flex-1">
              <div class="flex items-center gap-2 mb-1">
                <span class="px-2 py-0.5 rounded text-xs font-mono bg-emerald-500/10 text-emerald-300">GET</span>
                <code class="text-sm font-mono text-slate-200">/workink-return</code>
              </div>
              <p class="text-xs text-slate-400">Work.ink return handler</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}