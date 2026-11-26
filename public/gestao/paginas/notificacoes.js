// Operacional > Notificações: regras dos avisos que aparecem no canto da tela (lib/notificacao.js).
// Criar, editar, pausar/ativar, testar ("Ver no canto da tela") e excluir. Cada tipo (catálogo TIPOS) traz os seus campos, as
// variáveis da mensagem e a conta; a coluna "Agora" verifica na hora e mostra se a regra está disparando e onde.
import { esc } from '../lib/dados.js';
import { mostrarNotificacao, htmlNotificacao, carregarContexto, montarTexto, basesDaRegra, TIPOS } from '../lib/notificacao.js';
// quem recebe: o mesmo código que o servidor usa para escolher as regras de cada login (18/11/2026)
import { recebe, TELAS_PADRAO } from '../lib/destino-notificacao.js';

const NIVEIS = [['info', 'Informação'], ['alerta', 'Atenção'], ['critico', 'Crítico']];
const REPETIR = [['sessao', 'Volta na próxima vez que abrir o portal'], ['diaria', 'Volta no dia seguinte'], ['horas:1', 'Volta depois de 1 hora'],
  ['horas:4', 'Volta depois de 4 horas'], ['horas:8', 'Volta depois de 8 horas']];
const num = (s) => { const t = String(s ?? '').trim().replace(/\./g, '').replace(',', '.'); return t === '' ? null : Number(t); };
const fmtNum = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 }));
const padrao = (c) => (typeof c.padrao === 'function' ? c.padrao() : c.padrao);

async function chamar(metodo, corpo) {
  const r = await fetch('/api/notificacoes', { method: metodo, credentials: 'same-origin', cache: 'no-store',
    headers: corpo ? { 'Content-Type': 'application/json' } : undefined, body: corpo ? JSON.stringify(corpo) : undefined });
  if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.erro || 'Não foi possível falar com o servidor (' + r.status + ').');
  return j;
}

export async function montar(ctx) {
  const { pagina, pode } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando as notificações…</div>';
  let regras = [], usuarios = [], contexto = {}, bases = [], unidades = [], ctxAval = null, telas = [], usamDados = [];
  const filtro = { busca: '', ver: 'todas' };
  try {
    const j = await chamar('GET');
    regras = j.regras; usuarios = j.usuarios; contexto = j.contexto || {}; telas = j.telas || []; usamDados = j.usamDados || [];
    if (pode('bomba-estoque')) {
      const b = await fetch('/api/bomba/bases', { credentials: 'same-origin', cache: 'no-store' }).then((r) => (r.ok ? r.json() : { bases: [] })).catch(() => ({ bases: [] }));
      bases = b.bases.filter((x) => x.ativo);
    }
  } catch (e) {
    if (e.message !== 'sessão') pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }

  pagina.innerHTML = `
    <section class="painel painel-tabela">
      <div class="painel-cab"><h2>Avisos criados</h2><span class="conta" id="nt-conta"></span></div>
      <div class="tabela-ferramentas nt-ferramentas">
        <input type="search" id="nt-busca" placeholder="Procurar notificação…" aria-label="Procurar notificação" autocomplete="off">
        <div class="segmentado" role="group" aria-label="Mostrar">
          <button type="button" data-ver="todas" aria-pressed="true">Todas</button>
          <button type="button" data-ver="ativas" aria-pressed="false">Ativas</button>
          <button type="button" data-ver="pausadas" aria-pressed="false">Pausadas</button>
        </div>
        <button type="button" class="btn btn-principal nt-nova" id="nt-nova"><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Nova notificação</span></button>
      </div>
      <div class="tabela-rolagem"><table class="dados nt-tabela" id="nt-tabela"></table></div>
    </section>
    <dialog class="dialogo nt-dialogo" id="nt-dlg" aria-labelledby="nt-dlg-titulo">
      <form method="dialog" id="nt-form" novalidate>
        <h2 id="nt-dlg-titulo">Nova notificação</h2>
        <div class="grade-form nt-grade">
          <label class="campo-form largo"><span>Tipo de aviso</span><select name="tipo" class="campo-sel">${Object.entries(TIPOS).map(([k, t]) => '<option value="' + k + '">' + esc(t.rotulo) + '</option>').join('')}</select></label>
          <label class="campo-form largo"><span>Nome (título do aviso)</span><input name="nome" maxlength="80" autocomplete="off" required></label>
          <div class="largo nt-campos-tipo" id="nt-campos-tipo"></div>
          <fieldset class="campo-form largo nt-niveis"><legend>Nível</legend>
            <div class="segmentado" role="group" aria-label="Nível do aviso">${NIVEIS.map(([k, r]) => '<button type="button" data-nivel="' + k + '" aria-pressed="false">' + r + '</button>').join('')}</div>
          </fieldset>
          <label class="campo-form largo"><span>Mensagem</span><textarea name="mensagem" rows="3" maxlength="600"></textarea></label>
          <div class="largo nt-campos" id="nt-variaveis" aria-label="Inserir na mensagem"></div>
          <div class="largo nt-previa-caixa"><span class="nt-previa-rot" id="nt-previa-rot">Como fica</span><div class="nt-previa" id="nt-previa" aria-live="polite"></div></div>
          <fieldset class="campo-form largo"><legend>Para quem</legend>
            <label class="nt-opcao"><input type="radio" name="dest" value="todos"> <span id="nt-quem-todos">Todos</span></label>
            <label class="nt-opcao"><input type="radio" name="dest" value="telas"> Quem tem acesso a estas telas:</label>
            <div class="nt-telas oculto" id="nt-telas"></div>
            <label class="nt-opcao"><input type="radio" name="dest" value="usuarios"> Só estes usuários:</label>
            <div class="nt-usuarios" id="nt-usuarios"></div>
            <p class="nota nt-recebem" id="nt-recebem" aria-live="polite"></p>
          </fieldset>
          <label class="campo-form largo"><span>Depois de fechar no X</span><select name="repetir" class="campo-sel">${REPETIR.map(([k, r]) => '<option value="' + k + '">' + esc(r) + '</option>').join('')}</select></label>
          <label class="nt-opcao largo nt-celular"><input type="checkbox" name="celular"> <span>Enviar também para o celular
            <small>Chega no celular de quem recebe este aviso e ativou as notificações no aparelho (pelo sino), mesmo com o portal fechado.
            Repete conforme "Depois de fechar no X".</small></span></label>
          <label class="nt-opcao largo"><input type="checkbox" name="ativa"> Ativa</label>
        </div>
        <p class="erro-form oculto" id="nt-erro" role="alert"></p>
        <div class="dialogo-acoes">
          <button type="button" class="btn" id="nt-cancelar">Cancelar</button>
          <button type="button" class="btn" id="nt-testar">Ver no canto da tela</button>
          <button type="submit" class="btn btn-principal" id="nt-salvar">Salvar</button>
        </div>
      </form>
    </dialog>`;
  const el = (id) => pagina.querySelector('#' + id);
  const form = el('nt-form');

  // ---------- lista ----------
  const nomes = { base: (id) => (id === null || id === undefined ? 'todas as bases' : (bases.find((b) => b.id === id) || {}).nome || 'base ' + id) };
  const resumo = (r) => { const t = TIPOS[r.tipo]; try { return t ? t.resumo(r.condicao, nomes) : r.tipo; } catch { return '—'; } };
  const quemTodos = (tipo) => (TIPOS[tipo] ? TIPOS[tipo].quem : 'Todos');
  const nomeTela = (id) => { for (const g of telas) { const i = g.itens.find((x) => x.id === id); if (i) return i.rotulo.replace(/ \(.*\)$/, ''); } return id; };
  const listaCurta = (ns) => (ns.length <= 2 ? ns.join(' e ') : ns.slice(0, 2).join(', ') + ' e mais ' + (ns.length - 2));
  const paraQuem = (r) => (r.destinatarios.modo === 'usuarios'
    ? (r.destinatarios.ids.length === 1 ? '1 usuário' : r.destinatarios.ids.length + ' usuários')
    : r.destinatarios.modo === 'telas' ? 'Quem acessa ' + listaCurta(r.destinatarios.telas.map(nomeTela)) : quemTodos(r.tipo));
  // quem recebe agora (mesma conta do servidor): nomes no título da coluna "Para quem"
  const recebedores = (r) => usuarios.filter((u) => recebe(u.permissoes || [], u.id, r, usamDados));
  const nomesDest = (r) => { const us = recebedores(r); return us.length ? 'Recebem agora (' + us.length + '): ' + us.map((u) => u.nome).join(', ') : 'Ninguém recebe agora'; };
  const rotuloDe = (lista, v) => (lista.find(([k]) => k === v) || [null, v])[1];
  function agoraHtml(r) {
    if (!r.ativa) return '<span class="sit nt-pausada">Pausada</span>';
    if (!ctxAval) return '<span class="sem-dado" title="Verificando…">—</span>';
    const t = TIPOS[r.tipo], x = t ? t.avaliar(r, ctxAval) : null;
    if (x === null) return '<span class="sem-dado" title="Seu acesso não inclui os dados deste tipo">—</span>';
    return x.length ? '<span class="sit sit-ruim" title="' + esc(x.map((y) => y.onde).join('\n')) + '">' + (x.length === 1 && r.tipo !== 'estoque-baixo' ? 'Disparando' : 'Disparando em ' + x.length) + '</span>'
      : '<span class="sit sit-ok">Tudo certo</span>';
  }
  function desenhar() {
    if (!el('nt-tabela')) return;
    const t = filtro.busca.trim().toLowerCase();
    const lista = regras.filter((r) => (filtro.ver === 'todas' || (filtro.ver === 'ativas') === r.ativa) && (!t || r.nome.toLowerCase().includes(t)));
    el('nt-conta').textContent = lista.length === regras.length ? regras.length + (regras.length === 1 ? ' notificação' : ' notificações') : lista.length + ' de ' + regras.length;
    if (!regras.length) {
      el('nt-tabela').innerHTML = '<tbody><tr><td><div class="vazio nt-vazio"><strong>Nenhuma notificação criada.</strong> Os avisos aparecem no canto da tela para quem estiver no portal.' +
        '<button type="button" class="btn" data-sugestao>Começar pelo aviso de estoque baixo</button></div></td></tr></tbody>';
      return;
    }
    el('nt-tabela').innerHTML = '<thead><tr><th><span>Notificação</span></th><th><span>Condição</span></th><th><span>Para quem</span></th><th><span>Depois de fechar</span></th>' +
      '<th><span>Agora</span></th><th><span>Ativa</span></th><th class="nt-col-acoes"><span class="sr">Ações</span></th></tr></thead><tbody>' +
      (lista.length ? lista.map((r) => '<tr class="' + (r.ativa ? '' : 'nt-inativa') + '">' +
        '<td><strong>' + esc(r.nome) + '</strong><small class="cidade-linha">' + esc(TIPOS[r.tipo] ? TIPOS[r.tipo].rotulo : r.tipo) + ' · ' + esc(rotuloDe(NIVEIS, r.nivel)) + (r.celular ? ' · também no celular' : '') + '</small></td>' +
        '<td>' + esc(resumo(r)) + '</td>' +
        '<td><span title="' + esc(nomesDest(r)) + '">' + esc(paraQuem(r)) + '</span></td>' +
        '<td>' + esc(rotuloDe(REPETIR, r.repetir)) + '</td>' +
        '<td>' + agoraHtml(r) + '</td>' +
        '<td><button type="button" class="nt-chave" role="switch" aria-checked="' + r.ativa + '" data-ativar="' + r.id + '" aria-label="' + (r.ativa ? 'Pausar ' : 'Ativar ') + esc(r.nome) + '"><span class="interruptor" aria-hidden="true"></span></button></td>' +
        '<td class="nt-col-acoes"><div class="nt-acoes">' +
          '<button type="button" class="btn-lixeira btn-editar" data-testar="' + r.id + '" aria-label="Ver ' + esc(r.nome) + ' no canto da tela" title="Ver no canto da tela"><svg aria-hidden="true"><use href="#i-olho"/></svg></button>' +
          '<button type="button" class="btn-lixeira btn-editar" data-editar="' + r.id + '" aria-label="Editar ' + esc(r.nome) + '" title="Editar"><svg aria-hidden="true"><use href="#i-lapis"/></svg></button>' +
          '<button type="button" class="btn-lixeira" data-excluir="' + r.id + '" aria-label="Excluir ' + esc(r.nome) + '" title="Excluir"><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button>' +
        '</div></td></tr>').join('')
        : '<tr><td colspan="7"><div class="vazio">Nenhuma notificação com esse filtro.</div></td></tr>') + '</tbody>';
  }
  desenhar();
  // "Agora" e a lista de unidades precisam dos dados (pesado): carrega depois de a lista aparecer
  const tiposTodos = Object.keys(TIPOS).map((t) => ({ tipo: t, condicao: {} }));
  carregarContexto(tiposTodos, pode, contexto).then((c) => {
    ctxAval = c;
    if (c.dados) unidades = [...new Set(c.dados.linhas.map((l) => l.cc).filter((u) => u && !/^\(sem /.test(u)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    desenhar();
  }).catch(() => { ctxAval = { contexto }; desenhar(); });

  const avisarMudou = () => window.dispatchEvent(new CustomEvent('notificacoes-mudaram'));

  // ---------- formulário: campos do tipo ----------
  let editando = null, nivel = 'alerta', tipoAtual = 'estoque-baixo';
  function opcoesDe(c, valor) {
    let ops = c.opcoes;
    if (ops === 'bases') ops = [['', 'Todas as bases'], ...bases.map((b) => [String(b.id), b.nome])];
    if (ops === 'unidades') ops = [['', 'Todas as unidades'], ...unidades.map((u) => [u, u])];
    const v = valor === null || valor === undefined ? '' : String(valor);
    if (v && !ops.some(([k]) => String(k) === v)) ops = [...ops, [v, v + (c.opcoes === 'bases' ? ' (inativa ou sem acesso)' : '')]];
    return ops.map(([k, r]) => '<option value="' + esc(String(k)) + '"' + (String(k) === v ? ' selected' : '') + '>' + esc(r) + '</option>').join('');
  }
  function desenharCamposTipo(cond) {
    const t = TIPOS[tipoAtual];
    el('nt-campos-tipo').innerHTML = '<div class="nt-grade-tipo">' + t.campos.map((c) => {
      const v = c.id === 'base_ids' && cond ? basesDaRegra(cond) : cond && cond[c.id] !== undefined ? cond[c.id] : padrao(c);
      const nome = 'c_' + c.id;
      if (c.tipo === 'multi') {   // caixas de marcar (bases): as marcadas que não estão mais na lista continuam aparecendo
        const ops = c.opcoes === 'bases' ? bases.map((b) => [b.id, b.nome]) : c.opcoes;
        const sel = (v || []).map(String);
        for (const x of sel) if (!ops.some(([k]) => String(k) === x)) ops.push([x, 'base ' + x + ' (inativa ou sem acesso)']);
        return '<fieldset class="campo-form largo nt-multi"><legend>' + esc(c.rotulo) + (c.dica ? ' <small>(' + esc(c.dica) + ')</small>' : '') + '</legend>' +
          '<div class="nt-multi-opcoes">' + (ops.length ? ops.map(([k, r]) => '<label class="nt-opcao"><input type="checkbox" name="' + nome + '" value="' + esc(String(k)) + '"' +
            (sel.includes(String(k)) ? ' checked' : '') + '> ' + esc(r) + '</label>').join('') : '<p class="nota">Nenhuma base ativa.</p>') + '</div></fieldset>';
      }
      const campo =c.tipo === 'select' ? '<select name="' + nome + '" class="campo-sel">' + opcoesDe(c, v) + '</select>'
        : c.tipo === 'data' ? '<input type="date" name="' + nome + '" value="' + esc(v || '') + '">'
        : '<input name="' + nome + '" inputmode="decimal" autocomplete="off" value="' + esc(fmtNum(v)) + '">';
      return '<label class="campo-form' + (c.largo ? ' largo' : '') + '"><span>' + esc(c.rotulo) + '</span>' + campo + '</label>';
    }).join('') + '</div>';
    el('nt-variaveis').innerHTML = t.variaveis.length ? t.variaveis.map((v) => '<button type="button" class="pr-chip nt-campo" data-campo="' + v + '">{' + v + '}</button>').join('') : '';
    el('nt-variaveis').classList.toggle('oculto', !t.variaveis.length);
    el('nt-quem-todos').textContent = t.quem;
    desenharUsuarios(lerDestIds());
  }
  function lerCondicao() {
    const t = TIPOS[tipoAtual], c = {};
    for (const campo of t.campos) {
      if (campo.tipo === 'multi') {
        const vs = [...form.querySelectorAll('input[name="c_' + campo.id + '"]:checked')].map((x) => x.value);
        c[campo.id] = campo.opcoes === 'bases' ? vs.map(Number) : vs;
        continue;
      }
      const v = form.elements['c_' + campo.id].value;
      if (campo.tipo === 'numero') c[campo.id] = num(v);
      else if (campo.tipo === 'data') c[campo.id] = v;
      else if (campo.opcoes === 'bases') c[campo.id] = v === '' ? null : Number(v);
      else c[campo.id] = v === '' ? null : v;
    }
    return c;
  }
  const lerDestIds = () => [...form.querySelectorAll('input[name="u"]:checked')].map((c) => Number(c.value));
  const lerTelas = () => [...form.querySelectorAll('input[name="tela"]:checked')].map((c) => c.value);
  // telas do menu para marcar (por grupo); vêm marcadas as do padrão do tipo quando a regra ainda não tem lista própria
  function desenharTelas(sel) {
    el('nt-telas').innerHTML = telas.map((g) => '<fieldset class="nt-telas-grupo"><legend>' + esc(g.grupo) + '</legend>' +
      g.itens.map((i) => '<label class="nt-opcao"><input type="checkbox" name="tela" value="' + esc(i.id) + '"' + (sel.includes(i.id) ? ' checked' : '') + '> ' +
        esc(i.rotulo.replace(/ \(.*\)$/, '')) + '</label>').join('') + '</fieldset>').join('');
  }
  function mostrarRecebem() {
    const r = lerForm(), us = recebedores(r);
    el('nt-recebem').textContent = us.length ? 'Recebem agora: ' + us.length + (us.length === 1 ? ' usuário' : ' usuários') + ' (' + listaCurta(us.map((u) => u.nome)) + ').'
      : 'Ninguém recebe com essa escolha (ou ninguém tem acesso aos dados deste aviso).';
  }
  function lerForm() {
    const dest = form.querySelector('input[name="dest"]:checked');
    return {
      id: editando ? editando.id : undefined, nome: form.nome.value.trim(), tipo: tipoAtual, ativa: form.ativa.checked, condicao: lerCondicao(),
      mensagem: form.mensagem.value.trim(), nivel,
      destinatarios: dest && dest.value === 'usuarios' ? { modo: 'usuarios', ids: lerDestIds() }
        : dest && dest.value === 'telas' ? { modo: 'telas', telas: lerTelas() } : { modo: 'todos' },
      repetir: form.repetir.value, celular: form.celular.checked,
    };
  }
  // texto da prévia: o que a regra mostraria agora (se estiver disparando) ou o exemplo do tipo
  // primeiro aviso que a regra daria agora (com os dados reais); null se nada dispara ou faltam campos
  function avaliarPrevia(r) {
    if (!ctxAval || !TIPOS[r.tipo]) return null;
    try { const x = TIPOS[r.tipo].avaliar({ ...r, id: 0 }, ctxAval); return x && x.length ? x[0] : null; } catch { return null; }
  }
  // o aviso como sairia agora (dados reais, com o link já filtrado) ou, se a regra não está disparando, o exemplo do tipo
  // com dados fictícios, marcado como exemplo para não ser confundido com um aviso de verdade
  const AVISO_EXEMPLO = 'Exemplo com dados fictícios: agora esta regra não está disparando.';
  function amostra(r) {
    const x = avaliarPrevia(r);
    if (x) return { real: true, titulo: r.nome || 'Aviso', texto: x.texto, acao: x.acao || TIPOS[r.tipo].acao };
    return { real: false, titulo: 'Exemplo · ' + (r.nome || 'Aviso'), texto: montarTexto(r.mensagem, TIPOS[r.tipo].exemplo) + ' (' + AVISO_EXEMPLO + ')', acao: TIPOS[r.tipo].acao };
  }
  function testar(chave, r) {
    const a = amostra(r);
    mostrarNotificacao({ chave, titulo: a.titulo, texto: a.texto, nivel: r.nivel, acao: a.acao });
  }
  function previa() {
    mostrarRecebem();
    const r = lerForm(), a = amostra(r);
    el('nt-previa-rot').textContent = a.real ? 'Como fica (com os dados de agora)' : 'Como fica (exemplo: a regra não está disparando agora)';
    el('nt-previa').innerHTML = '<div class="notif notif-' + r.nivel + ' notif-estatica">' +
      htmlNotificacao({ titulo: r.nome || 'Aviso', texto: a.real ? a.texto : montarTexto(r.mensagem, TIPOS[r.tipo].exemplo), nivel: r.nivel, acao: a.acao }, true) + '</div>';
  }
  function marcarNivel(n) {
    nivel = n;
    form.querySelectorAll('[data-nivel]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.nivel === n)));
    previa();
  }
  function desenharUsuarios(ids) {
    const acesso = TIPOS[tipoAtual].acesso;
    el('nt-usuarios').innerHTML = usuarios.map((u) => '<label class="nt-opcao"><input type="checkbox" name="u" value="' + u.id + '"' + (ids.includes(u.id) ? ' checked' : '') + '> ' + esc(u.nome) +
      (acesso && u.acessos && !u.acessos[acesso] ? ' <small class="aviso-linha">sem acesso a estes dados: não vai ver</small>' : '') + '</label>').join('') || '<p class="nota">Nenhum usuário ativo.</p>';
  }
  function trocarTipo(novo, manterNome) {
    const anterior = TIPOS[tipoAtual];
    tipoAtual = novo;
    const t = TIPOS[novo];
    // nome e mensagem acompanham o tipo enquanto ainda forem os padrões do tipo anterior
    if (!manterNome && (!form.nome.value.trim() || form.nome.value === anterior.nome)) form.nome.value = t.nome;
    if (!form.mensagem.value.trim() || form.mensagem.value === anterior.mensagem) form.mensagem.value = t.mensagem;
    desenharCamposTipo(null);
    const dest = form.querySelector('input[name="dest"]:checked');
    if (!dest || dest.value !== 'telas') desenharTelas(TELAS_PADRAO[novo] || []);   // padrão do tipo novo
    previa();
  }
  function abrir(r) {
    editando = r && r.id ? r : null;
    const tipo = r && TIPOS[r.tipo] ? r.tipo : 'estoque-baixo', t = TIPOS[tipo];
    tipoAtual = tipo;
    el('nt-dlg-titulo').textContent = editando ? 'Editar notificação' : 'Nova notificação';
    form.tipo.value = tipo;
    form.tipo.disabled = !!editando;   // trocar o tipo de uma regra pronta = criar outra
    form.nome.value = r ? r.nome : t.nome;
    form.mensagem.value = r ? r.mensagem : t.mensagem;
    form.repetir.value = r ? r.repetir : 'diaria';
    form.ativa.checked = r ? r.ativa : true;
    form.celular.checked = r ? !!r.celular : false;   // notificações no celular (26/11/2026)
    const dst = r ? r.destinatarios : { modo: 'todos' };
    form.querySelector('input[name="dest"][value="' + (['usuarios', 'telas'].includes(dst.modo) ? dst.modo : 'todos') + '"]').checked = true;
    desenharTelas(dst.modo === 'telas' ? dst.telas : (TELAS_PADRAO[tipo] || []));
    el('nt-telas').classList.toggle('oculto', dst.modo !== 'telas');
    desenharCamposTipo(r ? r.condicao : null);
    desenharUsuarios(dst.ids || []);
    el('nt-usuarios').classList.toggle('oculto', dst.modo !== 'usuarios');
    el('nt-erro').classList.add('oculto');
    marcarNivel(r ? r.nivel : 'alerta');
    el('nt-dlg').showModal();
    (editando ? form.nome : form.tipo).focus();
  }
  form.addEventListener('input', previa);
  form.addEventListener('change', (e) => {
    if (e.target.name === 'tipo') { trocarTipo(e.target.value, false); return; }
    if (e.target.name === 'dest') {
      el('nt-usuarios').classList.toggle('oculto', e.target.value !== 'usuarios');
      el('nt-telas').classList.toggle('oculto', e.target.value !== 'telas');
    }
    previa();
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-nivel]');
    if (b) { marcarNivel(b.dataset.nivel); return; }
    const c = e.target.closest('[data-campo]');
    if (c) {   // insere {variável} onde está o cursor da mensagem
      const t = form.mensagem, ini = t.selectionStart ?? t.value.length, fim = t.selectionEnd ?? t.value.length, txt = '{' + c.dataset.campo + '}';
      t.value = t.value.slice(0, ini) + txt + t.value.slice(fim);
      t.focus(); t.setSelectionRange(ini + txt.length, ini + txt.length);
      previa();
    }
  });
  el('nt-cancelar').addEventListener('click', () => el('nt-dlg').close());
  el('nt-testar').addEventListener('click', () => {
    const r = lerForm();
    testar('teste-form', r);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = lerForm(), b = el('nt-salvar');
    b.disabled = true; b.textContent = 'Salvando…';
    try {
      const j = await chamar('POST', { acao: 'salvar', ...r });
      regras = editando ? regras.map((x) => (x.id === j.regra.id ? j.regra : x)) : [...regras, j.regra];
      regras.sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'));
      el('nt-dlg').close();
      desenhar(); avisarMudou();
      ctx.aviso('Notificação "' + j.regra.nome + '" salva.');
    } catch (err) {
      if (err.message !== 'sessão') { el('nt-erro').textContent = err.message; el('nt-erro').classList.remove('oculto'); }
    } finally { b.disabled = false; b.textContent = 'Salvar'; }
  });

  // ---------- lista: ativar, testar, editar, excluir ----------
  el('nt-nova').addEventListener('click', () => abrir(null));
  el('nt-busca').addEventListener('input', (e) => { filtro.busca = e.target.value; desenhar(); });
  pagina.querySelector('.nt-ferramentas .segmentado').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ver]'); if (!b) return;
    filtro.ver = b.dataset.ver;
    pagina.querySelectorAll('.nt-ferramentas [data-ver]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    desenhar();
  });
  el('nt-tabela').addEventListener('click', async (e) => {
    if (e.target.closest('[data-sugestao]')) { abrir(null); return; }
    const alvo = e.target.closest('[data-ativar], [data-testar], [data-editar], [data-excluir]');
    if (!alvo) return;
    const d = alvo.dataset, r = regras.find((x) => x.id === Number(d.ativar || d.testar || d.editar || d.excluir));
    if (!r) return;
    if (d.testar) {
      testar('teste-' + r.id, r);
    } else if (d.editar) abrir(r);
    else if (d.excluir) {
      if (!(await confirmar('Excluir a notificação "' + r.nome + '"? Ela para de aparecer para todos.'))) return;
      try { await chamar('POST', { acao: 'excluir', id: r.id }); regras = regras.filter((x) => x.id !== r.id); desenhar(); avisarMudou(); ctx.aviso('Notificação excluída.'); }
      catch (err) { if (err.message !== 'sessão') ctx.aviso(err.message); }
    } else if (d.ativar) {
      const nova = !r.ativa;
      alvo.disabled = true;
      try { await chamar('POST', { acao: 'ativar', id: r.id, ativa: nova }); r.ativa = nova; desenhar(); avisarMudou(); }
      catch (err) { if (err.message !== 'sessão') ctx.aviso(err.message); alvo.disabled = false; }
    }
  });
  return { desmontar() { const d = el('nt-dlg'); if (d && d.open) d.close(); } };
}
