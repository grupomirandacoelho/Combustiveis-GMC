// "Gerenciar acessos" (só administradores): logins e funções (perfis de acesso).
//  - Tipo de acesso de um login: Administrador (tudo), uma Função (as páginas da função; muda junto quando a função
//    é editada) ou Personalizado (as páginas marcadas no próprio login). Dá para partir de uma função e personalizar.
//  - Funções: criar, editar e excluir. Excluir uma função não tira acesso de ninguém: os logins dela viram
//    personalizados com as mesmas páginas.
// O servidor confere tudo de novo (lib/permissoes.js, lib/usuarios.js, functions/api/usuarios e /api/funcoes).
import { esc, fmt } from '../lib/dados.js';
import { htmlApoio } from '../lib/filtros.js';

const quando = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' às ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
};
const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const NIVEIS = [['', 'Sem acesso'], ['consulta', 'Só consulta'], ['edicao', 'Consulta e edição']];

// Editor de permissões (caixas por página; páginas com "niveis" viram sem acesso / só consulta / consulta e edição).
// Usado no formulário do login e no da função.
function criarEditor(el, catalogo, prefixo) {
  const edicaoDe = new Map(catalogo.flatMap((g) => g.itens.filter((i) => i.nivelDe).map((i) => [i.nivelDe, i.id])));
  el.innerHTML = catalogo.map((g) =>
    '<fieldset class="perm-bloco"><legend>' + esc(g.grupo) +
      ' <button type="button" class="link-acao" data-marcar="' + esc(g.grupo) + '">marcar todos</button></legend>' +
      g.itens.filter((it) => !it.nivelDe).map((it) => it.niveis
        ? '<div class="perm-nivel" role="radiogroup" aria-label="' + esc(it.rotulo) + '"><span class="perm-nivel-nome">' + esc(it.rotulo) + '</span>' +
            NIVEIS.map(([v, rot]) => '<label class="opcao-linha"><input type="radio" name="' + prefixo + '-nivel-' + esc(it.id) + '" value="' + v +
              '" data-nivel="' + esc(it.id) + '" data-grupo="' + esc(g.grupo) + '"> <span>' + rot + '</span></label>').join('') + '</div>'
        : '<label class="opcao-linha"><input type="checkbox" data-perm value="' + esc(it.id) + '"' + (it.requer ? ' data-requer="' + esc(it.requer) + '"' : '') +
          ' data-grupo="' + esc(g.grupo) + '"> <span>' + esc(it.rotulo) + '</span></label>').join('') +
    '</fieldset>').join('');
  const caixas = () => [...el.querySelectorAll('input[data-perm]')];
  const paginasNivel = [...edicaoDe.keys()];
  const radios = (id) => [...el.querySelectorAll('input[data-nivel="' + id + '"]')];
  const definirNivel = (id, v) => radios(id).forEach((r) => { r.checked = r.value === v; });
  const nivelAtual = (id) => (radios(id).find((r) => r.checked) || { value: '' }).value;
  el.addEventListener('change', (e) => {
    const c = e.target;
    if (!c.matches('input[data-perm]')) return;
    // "alterar postos" precisa de "ver a lista"; tirar "ver a lista" tira também "alterar"
    if (c.checked && c.dataset.requer) { const r = caixas().find((x) => x.value === c.dataset.requer); if (r) r.checked = true; }
    if (!c.checked) caixas().filter((x) => x.dataset.requer === c.value).forEach((x) => { x.checked = false; });
  });
  el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-marcar]');
    if (!b) return;
    const doGrupo = caixas().filter((c) => c.dataset.grupo === b.dataset.marcar);
    const niveis = paginasNivel.filter((id) => radios(id)[0].dataset.grupo === b.dataset.marcar);
    const marcar = !(doGrupo.every((c) => c.checked) && niveis.every((id) => nivelAtual(id) === 'edicao'));
    doGrupo.forEach((c) => { c.checked = marcar; });
    niveis.forEach((id) => definirNivel(id, marcar ? 'edicao' : ''));
  });
  return {
    definir(lista) {
      caixas().forEach((c) => { c.checked = lista.includes(c.value); });
      paginasNivel.forEach((id) => definirNivel(id, lista.includes(edicaoDe.get(id)) ? 'edicao' : lista.includes(id) ? 'consulta' : ''));
    },
    ler() {
      const lista = caixas().filter((c) => c.checked).map((c) => c.value);
      for (const id of paginasNivel) {
        const n = nivelAtual(id);
        if (n) lista.push(id);
        if (n === 'edicao') lista.push(edicaoDe.get(id));
      }
      return lista;
    },
    travar(sim) {
      el.classList.toggle('desativado', sim);
      el.querySelectorAll('input, button[data-marcar]').forEach((x) => { x.disabled = sim; });
    },
  };
}

export async function montar(ctx) {
  const { pagina } = ctx;
  pagina.innerHTML = '<div class="carregando"><div class="giro"></div>Carregando os logins…</div>';
  let usuarios = [], catalogo = [], funcoes = [], euId = null, bombaBases = [];
  async function carregar() {
    const r = await fetch('/api/usuarios', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || 'Não foi possível ler os logins. Recarregue a página.');
    usuarios = j.usuarios; catalogo = j.catalogo; euId = j.eu; funcoes = j.funcoes || []; bombaBases = j.bombaBases || [];
  }
  try { await carregar(); } catch (e) {
    pagina.innerHTML = '<div class="vazio">' + esc(e.message) + '</div>';
    return {};
  }
  const rotulos = new Map(catalogo.flatMap((g) => g.itens.map((i) => [i.id, { rotulo: i.rotulo, grupo: g.grupo, niveis: i.niveis, nivelDe: i.nivelDe }])));
  const total = [...rotulos.values()].filter((r) => !r.nivelDe).length;
  ctx.definirSub('Administradores acessam tudo e gerenciam os acessos. Os demais logins usam uma função (perfil de acesso) ou um acesso personalizado.');

  pagina.innerHTML = `
    <dl class="apoio apoio-pilha" id="ac-resumo"></dl>
    <div class="aviso-pendencias oculto" id="ac-aviso" role="status"></div>
    <section class="painel painel-tabela">
      <div class="painel-cab">
        <h2>Logins do portal</h2>
        <div class="acoes-cab"><button type="button" class="btn btn-principal" id="ac-novo"><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Novo login</span></button></div>
      </div>
      <div class="tabela-ferramentas">
        <input type="search" id="ac-busca" placeholder="Nome, usuário ou função…" aria-label="Procurar login" autocomplete="off">
        <span class="conta" id="ac-conta"></span>
      </div>
      <div class="tabela-rolagem"><table class="dados" id="ac-tabela"></table></div>
    </section>
    <section class="painel painel-tabela">
      <div class="painel-cab">
        <h2>Funções (perfis de acesso)</h2>
        <div class="acoes-cab"><button type="button" class="btn" id="ac-nova-funcao"><svg aria-hidden="true"><use href="#i-mais"/></svg><span class="txt">Nova função</span></button></div>
      </div>
      <p class="nota">Uma função é um conjunto de páginas com nome. Ao criar um login, escolha a função e as páginas dela são liberadas. Editar a função muda o acesso de todos os logins que a usam, na hora.</p>
      <div class="tabela-rolagem"><table class="dados" id="ac-funcoes"></table></div>
    </section>

    <dialog class="dialogo dialogo-largo" id="ac-dialogo" aria-labelledby="ac-dlg-titulo">
      <form id="ac-form" novalidate>
        <h2 id="ac-dlg-titulo"></h2>
        <p class="erro-form oculto" id="ac-erro" role="alert"></p>
        <div class="grade-form">
          <label class="campo-form"><span>Nome da pessoa</span><input name="nome" required autocomplete="off" placeholder="Ex.: Maria Silva…"></label>
          <label class="campo-form"><span>Usuário (para entrar)</span><input name="usuario" required autocomplete="off" spellcheck="false" autocapitalize="none" placeholder="Ex.: maria.silva…"></label>
        </div>
        <fieldset class="tipo-acesso">
          <legend>Tipo de acesso</legend>
          <label class="opcao-radio"><input type="radio" name="tipo" value="funcao"><span><strong>Função</strong>As páginas de uma função (perfil de acesso) pronta.</span></label>
          <div class="ac-funcao-linha" id="ac-funcao-linha">
            <select id="ac-funcao" class="campo-sel" aria-label="Função"></select>
            <button type="button" class="btn" id="ac-personalizar">Personalizar a partir desta função</button>
          </div>
          <label class="opcao-radio"><input type="radio" name="tipo" value="personalizado"><span><strong>Acesso personalizado</strong>Só as páginas marcadas abaixo, escolhidas uma a uma.</span></label>
          <label class="opcao-radio"><input type="radio" name="tipo" value="admin"><span><strong>Administrador</strong>Tudo no portal, inclusive criar e editar logins e funções.</span></label>
        </fieldset>
        <p class="nota oculto" id="ac-nota-funcao"></p>
        <div class="permissoes" id="ac-permissoes"></div>
        <fieldset class="tipo-acesso" id="ac-bases-campo">
          <legend>Bases da bomba interna</legend>
          <label class="opcao-radio"><input type="radio" name="bases" value="todas"><span><strong>Todas as bases</strong>Inclusive as que forem criadas depois.</span></label>
          <label class="opcao-radio"><input type="radio" name="bases" value="algumas"><span><strong>Só as bases marcadas</strong>Nas telas da Bomba interna a pessoa não vê o estoque, as compras nem os abastecimentos das outras bases, e não cria base nova.</span></label>
          <div class="ac-bases-lista" id="ac-bases-lista"></div>
        </fieldset>
        <label class="opcao-linha" id="ac-ativo-campo"><input type="checkbox" name="ativo"> <span>Login ativo (desmarque para bloquear a entrada sem excluir)</span></label>
        <div class="dialogo-acoes">
          <button type="button" class="btn" data-fechar>Cancelar</button>
          <button type="submit" class="btn btn-principal" id="ac-salvar"></button>
        </div>
      </form>
    </dialog>

    <dialog class="dialogo dialogo-largo" id="ac-dlg-funcao" aria-labelledby="ac-fn-titulo">
      <form id="ac-form-funcao" novalidate>
        <h2 id="ac-fn-titulo"></h2>
        <p class="erro-form oculto" id="ac-fn-erro" role="alert"></p>
        <div class="grade-form">
          <label class="campo-form"><span>Nome da função</span><input name="nome" required autocomplete="off" maxlength="60" placeholder="Ex.: Supervisor de unidade…"></label>
          <label class="campo-form"><span>Descrição <small>(opcional)</small></span><input name="descricao" autocomplete="off" maxlength="200" placeholder="Para que serve…"></label>
        </div>
        <p class="nota" id="ac-fn-nota"></p>
        <div class="permissoes" id="ac-fn-permissoes"></div>
        <div class="dialogo-acoes">
          <button type="button" class="btn" data-fechar>Cancelar</button>
          <button type="submit" class="btn btn-principal" id="ac-fn-salvar"></button>
        </div>
      </form>
    </dialog>

    <dialog class="dialogo" id="ac-senha" aria-labelledby="ac-senha-titulo">
      <h2 id="ac-senha-titulo">Senha provisória</h2>
      <p class="dialogo-explica" id="ac-senha-texto"></p>
      <div class="senha-mostrada"><code id="ac-senha-valor"></code><button type="button" class="btn" id="ac-copiar">Copiar</button></div>
      <p class="nota">Envie para a pessoa. No primeiro acesso ela escolhe uma senha nova. Esta senha não aparece de novo.</p>
      <div class="dialogo-acoes"><button type="button" class="btn btn-principal" data-fechar>Pronto</button></div>
    </dialog>

    <dialog class="dialogo" id="ac-confirma" aria-labelledby="ac-conf-titulo">
      <h2 id="ac-conf-titulo"></h2>
      <p class="dialogo-explica" id="ac-conf-texto"></p>
      <p class="erro-form oculto" id="ac-conf-erro" role="alert"></p>
      <div class="dialogo-acoes">
        <button type="button" class="btn" data-fechar>Cancelar</button>
        <button type="button" class="btn" id="ac-conf-ok"></button>
      </div>
    </dialog>`;
  const $ = (id) => pagina.querySelector('#' + id);
  const dlg = $('ac-dialogo'), form = $('ac-form');
  pagina.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  pagina.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
  const editorLogin = criarEditor($('ac-permissoes'), catalogo, 'lg');
  const editorFuncao = criarEditor($('ac-fn-permissoes'), catalogo, 'fn');

  function aviso(txt, erro) {
    const a = $('ac-aviso');
    a.innerHTML = txt ? '<span>' + esc(txt) + '</span>' : '';
    a.classList.toggle('oculto', !txt);
    a.classList.toggle('aviso-erro', !!erro);
  }

  // ---------- resumo das páginas de uma lista de permissões ----------
  function resumoLista(perms) {
    if (!perms.length) return '<span class="aviso-linha">Nenhuma página liberada</span>';
    const porGrupo = new Map();
    perms.forEach((p) => {
      const r = rotulos.get(p);
      if (!r || r.nivelDe) return;   // "edição" aparece junto da página: "Placas (edição)"
      if (!porGrupo.has(r.grupo)) porGrupo.set(r.grupo, []);
      porGrupo.get(r.grupo).push(r.niveis ? r.rotulo + (perms.includes(p + '-editar') ? ' (edição)' : ' (só consulta)') : r.rotulo);
    });
    return [...porGrupo.entries()].map(([g, itens]) => '<span class="perm-grupo"><b>' + esc(g) + ':</b> ' + esc(itens.join(', ')) + '</span>').join('');
  }
  const paginas = (perms) => perms.filter((p) => rotulos.has(p) && !rotulos.get(p).nivelDe).length;
  // bases da bomba interna liberadas (só aparece quando o login não vê todas)
  const nomeBase = (id) => (bombaBases.find((b) => b.id === id) || {}).nome || 'base ' + id;
  const resumoBases = (u) => (!u.bomba_bases ? '' : '<span class="perm-grupo"><b>Bases da bomba interna:</b> ' +
    esc(u.bomba_bases.length ? u.bomba_bases.map(nomeBase).join(', ') : 'nenhuma') + '</span>');
  const tipoDe = (u) => (u.papel === 'admin' ? 'Administrador' : u.funcao_id ? 'Função: ' + (u.funcao_nome || '?') : 'Personalizado');
  const situacaoDe = (u) => (!u.ativo ? 'Bloqueado' : u.trocar_senha ? 'Aguardando trocar a senha' : 'Ativo');

  // ---------- lista de logins: pesquisa e colunas que ordenam ----------
  const estado = { busca: '', ordem: { col: 'nome', dir: 1 } };
  const COLUNAS = [
    { id: 'nome', rot: 'Pessoa', v: (u) => semAcento(u.nome) },
    { id: 'tipo', rot: 'Tipo de acesso', v: (u) => semAcento(tipoDe(u)) },
    { id: 'pode', rot: 'Pode usar', v: (u) => (u.papel === 'admin' ? total + 1 : paginas(u.permissoes)) },
    { id: 'ultimo', rot: 'Último acesso', v: (u) => u.ultimo_acesso || '' },
    { id: 'situacao', rot: 'Situação', v: (u) => situacaoDe(u) },
  ];
  let visiveis = [];
  function desenhar() {
    const ativos = usuarios.filter((u) => u.ativo);
    $('ac-resumo').innerHTML = htmlApoio([
      { rot: 'Logins ativos', val: fmt.int(ativos.length) },
      { rot: 'Administradores', val: fmt.int(ativos.filter((u) => u.papel === 'admin').length) },
      { rot: 'Com função', val: fmt.int(ativos.filter((u) => u.papel !== 'admin' && u.funcao_id).length) },
      { rot: 'Personalizados', val: fmt.int(ativos.filter((u) => u.papel !== 'admin' && !u.funcao_id).length) },
      { rot: 'Bloqueados', val: fmt.int(usuarios.length - ativos.length) },
    ]);
    const t = semAcento(estado.busca.trim());
    const c = COLUNAS.find((x) => x.id === estado.ordem.col);
    visiveis = usuarios.filter((u) => !t || [u.nome, u.usuario, tipoDe(u), situacaoDe(u)].some((x) => semAcento(x).includes(t)))
      .sort((a, b) => {
        const va = c.v(a), vb = c.v(b);
        const d = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb), 'pt-BR');
        return estado.ordem.dir * d || semAcento(a.nome).localeCompare(semAcento(b.nome), 'pt-BR');
      });
    $('ac-conta').textContent = visiveis.length + (visiveis.length === 1 ? ' login' : ' logins');
    $('ac-tabela').innerHTML = '<thead><tr>' + COLUNAS.map((col) => {
      const ativa = estado.ordem.col === col.id;
      return '<th aria-sort="' + (ativa ? (estado.ordem.dir > 0 ? 'ascending' : 'descending') : 'none') + '"><button type="button" data-col="' + col.id + '">' +
        esc(col.rot) + (ativa ? '<span class="seta">' + (estado.ordem.dir > 0 ? '▲' : '▼') + '</span>' : '') + '</button></th>';
    }).join('') + '<th class="acoes-linha"><span>Ações</span></th></tr></thead><tbody>' +
      (visiveis.length ? visiveis.map((u, i) => {
        const sit = !u.ativo ? '<span class="sit sit-ruim">Bloqueado</span>'
          : u.trocar_senha ? '<span class="sit sit-alerta">Aguardando trocar a senha</span>'
          : '<span class="sit sit-ok">Ativo</span>';
        const eu = u.id === euId;
        const tipo = u.papel === 'admin' ? 'Administrador'
          : u.funcao_id ? '<span class="sit sit-livre">' + esc(u.funcao_nome || 'Função') + '</span><small class="cidade-linha">função · ' + paginas(u.permissoes) + ' de ' + total + ' páginas</small>'
          : 'Personalizado<small class="cidade-linha">' + paginas(u.permissoes) + ' de ' + total + ' páginas</small>';
        return '<tr class="' + (u.ativo ? '' : 'linha-apagada') + '">' +
          '<td class="trunc"><strong>' + esc(u.nome) + '</strong>' + (eu ? ' <span class="selo-pendente">você</span>' : '') +
            '<small class="cidade-linha">' + esc(u.usuario) + '</small></td>' +
          '<td>' + tipo + '</td>' +
          '<td class="trunc perm-lista">' + (u.papel === 'admin' ? '<span class="sem-dado">Tudo no portal</span>' : resumoLista(u.permissoes) + resumoBases(u)) + '</td>' +
          '<td>' + (u.ultimo_acesso ? esc(quando(u.ultimo_acesso)) : '<span class="sem-dado">Nunca entrou</span>') + '</td>' +
          '<td>' + sit + '</td>' +
          '<td class="acoes-linha">' +
            '<button type="button" class="btn-linha" data-acao="editar" data-i="' + i + '">Editar</button>' +
            '<button type="button" class="btn-linha" data-acao="senha" data-i="' + i + '">Nova senha</button>' +
            (eu ? '' : '<button type="button" class="btn-lixeira" data-acao="excluir" data-i="' + i + '" aria-label="Excluir login" title="Excluir login"><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button>') +
          '</td></tr>';
      }).join('') : '<tr><td colspan="6"><div class="vazio">Nenhum login com esse texto.</div></td></tr>') + '</tbody>';
    desenharFuncoes();
  }

  function desenharFuncoes() {
    $('ac-funcoes').innerHTML = '<thead><tr><th><span>Função</span></th><th><span>Pode usar</span></th><th class="n"><span>Logins</span></th>' +
      '<th class="acoes-linha"><span>Ações</span></th></tr></thead><tbody>' +
      (funcoes.length ? funcoes.map((f, i) =>
        '<tr><td class="trunc"><strong>' + esc(f.nome) + '</strong>' + (f.descricao ? '<small class="cidade-linha">' + esc(f.descricao) + '</small>' : '') + '</td>' +
        '<td class="trunc perm-lista">' + resumoLista(f.permissoes) + '</td>' +
        '<td class="n">' + fmt.int(f.logins) + '</td>' +
        '<td class="acoes-linha"><button type="button" class="btn-linha" data-fn="editar" data-i="' + i + '">Editar</button>' +
          '<button type="button" class="btn-lixeira" data-fn="excluir" data-i="' + i + '" aria-label="Excluir função" title="Excluir função"><svg aria-hidden="true"><use href="#i-lixeira"/></svg></button></td></tr>').join('')
        : '<tr><td colspan="4"><div class="vazio">Nenhuma função criada. Use "Nova função".</div></td></tr>') + '</tbody>';
  }
  desenhar();

  $('ac-busca').addEventListener('input', (e) => { estado.busca = e.target.value; desenhar(); });
  $('ac-tabela').addEventListener('click', (e) => {
    const col = e.target.closest('[data-col]');
    if (!col) return;
    const id = col.dataset.col;
    estado.ordem = estado.ordem.col === id ? { col: id, dir: -estado.ordem.dir } : { col: id, dir: id === 'ultimo' || id === 'pode' ? -1 : 1 };
    desenhar();
    const novo = $('ac-tabela').querySelector('[data-col="' + id + '"]');
    if (novo) novo.focus();
  });

  // ---------- formulário do login ----------
  let editando = null;   // null = novo login
  const tipoAtual = () => (form.querySelector('input[name="tipo"]:checked') || { value: 'personalizado' }).value;
  const funcaoEscolhida = () => funcoes.find((f) => String(f.id) === $('ac-funcao').value) || null;
  function preencherFuncoes(sel) {
    $('ac-funcao').innerHTML = funcoes.length
      ? funcoes.map((f) => '<option value="' + f.id + '"' + (f.id === sel ? ' selected' : '') + '>' + esc(f.nome) + '</option>').join('')
      : '<option value="">Nenhuma função criada</option>';
  }
  function atualizarTipo() {
    const tipo = tipoAtual();
    form.querySelector('input[name="tipo"][value="funcao"]').disabled = !funcoes.length || (!!editando && editando.id === euId);
    $('ac-funcao-linha').classList.toggle('oculto', tipo !== 'funcao');
    const nota = $('ac-nota-funcao');
    if (tipo === 'admin') {
      editorLogin.definir([...rotulos.keys()]);
      editorLogin.travar(true);
      nota.classList.add('oculto');
    } else if (tipo === 'funcao') {
      const f = funcaoEscolhida();
      editorLogin.definir(f ? f.permissoes : []);
      editorLogin.travar(true);
      nota.textContent = f ? 'Páginas da função "' + f.nome + '" (só leitura aqui). Para mudar só este login, use "Personalizar a partir desta função".' : '';
      nota.classList.toggle('oculto', !f);
    } else {
      editorLogin.travar(false);
      nota.classList.add('oculto');
    }
    $('ac-bases-campo').classList.toggle('oculto', tipo === 'admin');   // administrador vê todas
    atualizarBases();
  }
  // bases da bomba interna: "todas" ou só as marcadas
  const basesAtual = () => (form.querySelector('input[name="bases"]:checked') || { value: 'todas' }).value;
  function preencherBases(lista) {
    form.querySelectorAll('input[name="bases"]').forEach((r) => { r.checked = r.value === (lista ? 'algumas' : 'todas'); });
    $('ac-bases-lista').innerHTML = bombaBases.length
      ? bombaBases.map((b) => '<label class="opcao-linha"><input type="checkbox" data-base value="' + b.id + '"' + (lista && lista.includes(b.id) ? ' checked' : '') + '> <span>' +
          esc(b.nome) + (b.ativo ? '' : ' <small class="cidade-linha">inativa</small>') + '</span></label>').join('')
      : '<p class="nota">Nenhuma base cadastrada ainda (Bomba interna > Estoque).</p>';
    atualizarBases();
  }
  function atualizarBases() {
    const algumas = basesAtual() === 'algumas';
    $('ac-bases-lista').classList.toggle('oculto', !algumas);
    $('ac-bases-lista').querySelectorAll('input').forEach((c) => { c.disabled = !algumas; });
  }
  function abrir(u) {
    editando = u;
    form.reset();
    $('ac-erro').classList.add('oculto');
    $('ac-dlg-titulo').textContent = u ? 'Editar login' : 'Novo login';
    $('ac-salvar').textContent = u ? 'Salvar alterações' : 'Criar login';
    form.nome.value = u ? u.nome : '';
    form.usuario.value = u ? u.usuario : '';
    form.usuario.readOnly = !!u;
    const tipo = u ? (u.papel === 'admin' ? 'admin' : u.funcao_id ? 'funcao' : 'personalizado') : (funcoes.length ? 'funcao' : 'personalizado');
    form.querySelectorAll('input[name="tipo"]').forEach((r) => { r.checked = r.value === tipo; });
    preencherFuncoes(u && u.funcao_id ? u.funcao_id : (funcoes[0] || {}).id);
    editorLogin.definir(u ? (u.funcao_id ? u.personalizadas : u.permissoes) : []);
    $('ac-ativo-campo').classList.toggle('oculto', !u || u.id === euId);
    form.ativo.checked = u ? u.ativo : true;
    // o próprio login não pode deixar de ser administrador
    form.querySelectorAll('input[name="tipo"]').forEach((r) => { r.disabled = !!u && u.id === euId && r.value !== 'admin'; });
    preencherBases(u ? u.bomba_bases : null);
    atualizarTipo();
    dlg.showModal();
    form.nome.focus();
  }
  form.addEventListener('change', (e) => { if (e.target.name === 'tipo') atualizarTipo(); if (e.target.name === 'bases') atualizarBases(); });
  $('ac-funcao').addEventListener('change', atualizarTipo);
  $('ac-personalizar').addEventListener('click', () => {
    const f = funcaoEscolhida();
    form.querySelector('input[name="tipo"][value="personalizado"]').checked = true;
    atualizarTipo();
    if (f) editorLogin.definir(f.permissoes);
    const primeiro = $('ac-permissoes').querySelector('input:not([disabled])');
    if (primeiro) primeiro.focus();
  });
  $('ac-novo').addEventListener('click', () => abrir(null));

  async function enviar(url, metodo, corpo) {
    const r = await fetch(url, {
      method: metodo, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { location.href = '/?entrar=1'; throw new Error('sessão'); }
    if (!r.ok) throw new Error(j.erro || 'Não foi possível salvar. Tente de novo.');
    return j;
  }
  let senhaMostrada = null;   // {usuario, senha} para o botão Copiar
  function mostrarSenha(u, senha, novo) {
    senhaMostrada = { usuario: u.usuario, senha };
    $('ac-senha-titulo').textContent = novo ? 'Login criado' : 'Senha nova gerada';
    $('ac-senha-texto').textContent = (novo ? 'O login de ' : 'A senha de ') + u.nome + ' (usuário ' + u.usuario + ') ' +
      (novo ? 'já pode entrar com a senha provisória abaixo.' : 'foi trocada; os aparelhos em que estava conectado saíram.');
    $('ac-senha-valor').textContent = senha;
    $('ac-copiar').textContent = 'Copiar';
    $('ac-senha').showModal();
    $('ac-copiar').focus();
  }
  $('ac-copiar').addEventListener('click', async () => {
    const t = 'Portal Gestão de Combustível: ' + location.origin + '\nUsuário: ' + senhaMostrada.usuario + '\nSenha provisória: ' + senhaMostrada.senha;
    try { await navigator.clipboard.writeText(t); $('ac-copiar').textContent = 'Copiado'; }
    catch { $('ac-copiar').textContent = 'Selecione e copie'; }
  });
  $('ac-senha').addEventListener('close', () => { senhaMostrada = null; $('ac-senha-valor').textContent = ''; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('ac-erro');
    const tipo = tipoAtual();
    const f = tipo === 'funcao' ? funcaoEscolhida() : null;
    const corpo = {
      nome: form.nome.value, papel: tipo === 'admin' ? 'admin' : 'gestor',
      funcao_id: f ? f.id : null,
      // com função, a lista personalizada fica guardada como estava (volta a valer se a função for tirada)
      permissoes: tipo === 'personalizado' ? editorLogin.ler() : (editando ? editando.personalizadas : []),
    };
    if (!editando) corpo.usuario = form.usuario.value;
    else if (editando.id !== euId) corpo.ativo = form.ativo.checked;
    // bases da bomba interna: null = todas; administrador sempre todas
    corpo.bomba_bases = tipo === 'admin' || basesAtual() === 'todas' ? null
      : [...$('ac-bases-lista').querySelectorAll('input[data-base]:checked')].map((c) => Number(c.value));
    if (Array.isArray(corpo.bomba_bases) && !corpo.bomba_bases.length && bombaBases.length) {
      erro.textContent = 'Marque pelo menos uma base da bomba interna, ou escolha "Todas as bases".'; erro.classList.remove('oculto');
      return;
    }
    if (!corpo.nome.trim() || (!editando && !corpo.usuario.trim())) {
      erro.textContent = 'Preencha o nome e o usuário.'; erro.classList.remove('oculto');
      (corpo.nome.trim() ? form.usuario : form.nome).focus();
      return;
    }
    if (tipo === 'funcao' && !f) { erro.textContent = 'Escolha a função.'; erro.classList.remove('oculto'); return; }
    if (tipo === 'personalizado' && !corpo.permissoes.length) {
      erro.textContent = 'Marque pelo menos uma página que a pessoa pode usar.'; erro.classList.remove('oculto');
      return;
    }
    const btn = $('ac-salvar'), rot = btn.textContent;
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      const j = editando ? await enviar('/api/usuarios/' + editando.id, 'PUT', corpo) : await enviar('/api/usuarios', 'POST', corpo);
      dlg.close();
      await carregar(); desenhar();
      if (!editando) mostrarSenha(j.usuario, j.senha, true);
      else aviso('Alterações de ' + j.usuario.nome + ' salvas. Valem a partir da próxima página que a pessoa abrir.');
    } catch (err) {
      erro.textContent = err.message; erro.classList.remove('oculto');
    } finally {
      btn.disabled = false; btn.textContent = rot;
    }
  });

  // ---------- funções: criar, editar, excluir ----------
  const formFn = $('ac-form-funcao');
  let editandoFn = null;
  function abrirFuncao(f) {
    editandoFn = f;
    formFn.reset();
    $('ac-fn-erro').classList.add('oculto');
    $('ac-fn-titulo').textContent = f ? 'Editar função' : 'Nova função';
    $('ac-fn-salvar').textContent = f ? 'Salvar função' : 'Criar função';
    formFn.nome.value = f ? f.nome : '';
    formFn.descricao.value = f ? f.descricao : '';
    editorFuncao.definir(f ? f.permissoes : []);
    $('ac-fn-nota').textContent = f && f.logins ? 'Esta função está em ' + f.logins + (f.logins === 1 ? ' login' : ' logins') + ': o que mudar aqui vale para eles na hora.' : 'Marque as páginas que a função libera.';
    $('ac-dlg-funcao').showModal();
    formFn.nome.focus();
  }
  $('ac-nova-funcao').addEventListener('click', () => abrirFuncao(null));
  formFn.addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = $('ac-fn-erro');
    const corpo = { nome: formFn.nome.value, descricao: formFn.descricao.value, permissoes: editorFuncao.ler() };
    if (!corpo.nome.trim()) { erro.textContent = 'Dê um nome à função.'; erro.classList.remove('oculto'); formFn.nome.focus(); return; }
    if (!corpo.permissoes.length) { erro.textContent = 'Marque pelo menos uma página para a função.'; erro.classList.remove('oculto'); return; }
    const btn = $('ac-fn-salvar'), rot = btn.textContent;
    btn.disabled = true; btn.textContent = 'Salvando…';
    try {
      if (editandoFn) await enviar('/api/funcoes/' + editandoFn.id, 'PUT', corpo); else await enviar('/api/funcoes', 'POST', corpo);
      $('ac-dlg-funcao').close();
      await carregar(); desenhar();
      aviso('Função "' + corpo.nome.trim() + '" ' + (editandoFn ? 'salva.' + (editandoFn.logins ? ' Vale para os ' + editandoFn.logins + ' login(s) com ela a partir da próxima página que abrirem.' : '') : 'criada.'));
    } catch (err) {
      erro.textContent = err.message; erro.classList.remove('oculto');
    } finally {
      btn.disabled = false; btn.textContent = rot;
    }
  });
  $('ac-funcoes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fn]');
    if (!b) return;
    const f = funcoes[Number(b.dataset.i)];
    if (b.dataset.fn === 'editar') abrirFuncao(f);
    if (b.dataset.fn === 'excluir') {
      pedirConfirmacao('Excluir a função "' + f.nome + '"?',
        f.logins ? 'Os ' + f.logins + ' login(s) com esta função não perdem acesso: passam a "acesso personalizado" com as mesmas páginas.'
          : 'Nenhum login usa esta função.',
        'Excluir função', true, async () => {
          await enviar('/api/funcoes/' + f.id, 'DELETE');
          await carregar(); desenhar();
          aviso('Função "' + f.nome + '" excluída.');
        });
    }
  });

  // ---------- nova senha e exclusão de login (com confirmação) ----------
  let confirmar = null;
  function pedirConfirmacao(titulo, texto, botao, perigo, acao) {
    $('ac-conf-titulo').textContent = titulo;
    $('ac-conf-texto').textContent = texto;
    $('ac-conf-erro').classList.add('oculto');
    const ok = $('ac-conf-ok');
    ok.textContent = botao;
    ok.className = 'btn ' + (perigo ? 'btn-perigo' : 'btn-principal');
    confirmar = acao;
    $('ac-confirma').showModal();
    ok.focus();
  }
  $('ac-conf-ok').addEventListener('click', async () => {
    const ok = $('ac-conf-ok'), rot = ok.textContent;
    ok.disabled = true; ok.textContent = 'Aguarde…';
    try { await confirmar(); $('ac-confirma').close(); }
    catch (err) { $('ac-conf-erro').textContent = err.message; $('ac-conf-erro').classList.remove('oculto'); }
    finally { ok.disabled = false; ok.textContent = rot; }
  });
  $('ac-tabela').addEventListener('click', (e) => {
    const b = e.target.closest('[data-acao]');
    if (!b) return;
    const u = visiveis[Number(b.dataset.i)];
    if (b.dataset.acao === 'editar') abrir(u);
    if (b.dataset.acao === 'senha') {
      pedirConfirmacao('Gerar senha nova para ' + u.nome + '?',
        'A senha atual deixa de valer e a pessoa sai dos aparelhos em que está conectada. Ela entra com a senha provisória e escolhe uma nova.',
        'Gerar senha nova', false, async () => {
          const j = await enviar('/api/usuarios/' + u.id, 'PUT', { redefinirSenha: true });
          await carregar(); desenhar();
          setTimeout(() => mostrarSenha(j.usuario, j.senha, false), 0);
        });
    }
    if (b.dataset.acao === 'excluir') {
      pedirConfirmacao('Excluir o login de ' + u.nome + '?',
        'A pessoa não consegue mais entrar e o login sai da lista. O histórico do que ela alterou nos postos continua guardado. ' +
        'Se quiser só suspender, use Editar e desmarque "Login ativo".',
        'Excluir login', true, async () => {
          await enviar('/api/usuarios/' + u.id, 'DELETE');
          await carregar(); desenhar();
          aviso('Login de ' + u.nome + ' excluído.');
        });
    }
  });
  return { desmontar() { pagina.querySelectorAll('dialog').forEach((d) => { if (d.open) d.close(); }); } };
}
