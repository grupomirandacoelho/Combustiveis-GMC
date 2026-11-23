// Cadastro de motoristas integrado aos cartões (Ticket Log e TruckPag). Chamado pelo vigia junto com as APIs dos cartões
// (só no computador que tem as credenciais).
// Desde 12/11/2026 o portal não guarda CPF, data de nascimento nem CNH (pedido do usuário): esses dados só existem na
// alteração do Cadastro > Motoristas ("pessoais") até serem enviados aos cartões; depois o vigia avisa e o portal apaga
// (/api/sync/cadastros/cartoes "limpar"; de qualquer jeito somem em 7 dias). Nada disso é gravado em disco aqui.
//  1) criarNovos(): motorista ADICIONADO pelo portal é cadastrado na Ticket (cliente 245364, decisão do usuário) e na
//     TruckPag, com o CPF, o nascimento e a CNH digitados no cadastro. Liga com "criar": true em
//     %LOCALAPPDATA%\GestaoCombustivel\motoristas-cartoes.json.
//  2) editarTruckpag(): edição de nome ou senha TruckPag feita no portal é repetida na TruckPag pelo ID TruckPag do
//     cadastro, se quem editou informou CPF e nascimento no formulário (a TruckPag exige os dois em toda edição).
//     Liga com "editar": true. Situação (DESLIGADO etc.) não vai: o código de "inativo" da TruckPag não está na documentação.
//     Na Ticket ("editarTicket": true): PUT do motorista pelo código Ticket (precisa do CPF e do nascimento da edição) e,
//     se a senha Ticket mudou, a troca de senha (endereço próprio, só com o código).
// Passo 4 da migração (23/11/2026): regras do cadastro de motoristas e de placas nos cartões sem arquivos próprios (antes em
// scripts/motoristas_cartoes.mjs e scripts/placas_truckpag.mjs, sem mudar regra). Usado pelo vigia e pela nuvem (_shared).
// io = {api, log, agora(), chaves: {criar, editar, editarTicket, placasUnidade}, ticket: {host, basic}, truckpag: {hosts, token},
//   fetchCartao(url, opcoes) -> Response (as chamadas às APIs dos cartões; na simulação só as consultas saem de verdade),
//   motoristas() -> lista do cadastro (nome, usuario, senhaTicket, senhaTruckpag, matricula, codigoTicket, idTruckpag...),
//   ler/gravar(nome) ('motoristas-novos', 'motoristas-edicao', 'placas')}.
// tipo de senha na Ticket: IU = informada pelo usuário (o gestor define a senha). IE = impressa em envelope (exige o código de
// controle do envelope: INFORME_CODIGO_CONTROLE_ENVELOPE); IM = informada pelo motorista. Valores achados em 06/11/2026.
const TIPO_SENHA = 'IU';
const CLIENTE_TICKET = 245364;      // RAJA LOG - FILIAIS: o único em que o portal cadastra (decisão do usuário)
const EMPRESA_TRUCKPAG = 25298;     // empresa_id da Raja Log na TruckPag (lido de /veiculo)
const so = (v) => String(v ?? '').replace(/\D/g, '');
// motorista de teste (área do motorista): nunca vai para a Ticket nem para a TruckPag (criar, editar ou completar)
const USUARIOS_TESTE = new Set(['111444']);
export const ehTeste = (m) => USUARIOS_TESTE.has(String((m && m.usuario) || '')) || /^(MOTORISTA\s+)?(TESTE|FANTASMA)\b/i.test(String((m && m.nome) || '').trim());
const isoDeBr = (s) => { const m = String(s || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? m[3] + '-' + m[2] + '-' + m[1] : null; };

// a Ticket só aceita data com hora ("yyyy-MM-dd'T'HH:mm:ss"). m = planilha + dados pessoais da alteração (CPF, nascimento, CNH)
// semValidade: no cadastro novo a Ticket recusa com a validade da CNH ("Falha ao gerar offset ... TYPE_PINPAD", 06/11/2026);
// sem ela o cadastro passa (a restrição de vencimento fica a padrão da Ticket)
function corpoTicket(m, { semValidade = false } = {}) {
  const nasc = isoDeBr(m.dataNascimento);
  return { codigoCliente: CLIENTE_TICKET, codigoProduto: 4, nomeMotorista: m.nome, cpf: so(m.cpf), descricaoResponsavel: 'GESTOR FROTA',   // Gestor responsável: fixo (decisão do usuário)
   
    ...(nasc ? { dataNascimento: nasc + 'T00:00:00' } : {}), ...(m.matricula ? { numeroMatricula: Number(m.matricula) } : {}),
    ...(m.cnh ? { numeroCarteiraMotorista: String(m.cnh) } : {}), ...(m.cnhCategoria ? { categoriaCarteiraMotorista: m.cnhCategoria } : {}),
    ...(m.cnhValidade && !semValidade ? { dataVencimentoCarteira: isoDeBr(m.cnhValidade) + 'T00:00:00' } : {}) };
}

function ticket(io) {
  const c = io.ticket;
  const H = { Authorization: 'Basic ' + c.basic, 'Content-Type': 'application/json', Accept: 'application/json' };
  const chamar = async (metodo, rota, corpo) => {
    const r = await io.fetchCartao(c.host + rota, { method: metodo, headers: H, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(60_000) });
    return r.json().catch(() => ({ sucesso: false, mensagem: 'HTTP ' + r.status }));
  };
  return {
    async codigo(cpf) {   // código do motorista no cliente Raja Log (null se não existe)
      const j = await chamar('GET', `/ticketlog-servicos/ebs/motorista/${CLIENTE_TICKET}/4/${cpf}`);
      return j.sucesso && j.informacoes && j.informacoes[0] ? j.informacoes[0].codigo : null;
    },
    async alterar(codigo, m) {   // a alteração substitui o cadastro: vai tudo o que o portal sabe do motorista
      return chamar('PUT', '/ticketlog-servicos/ebs/motorista/' + codigo + '?version=new', corpoTicket(m));
    },
    async senha(codigo, senha) {
      return chamar('PUT', '/ticketlog-servicos/ebs/motorista/' + codigo + '/senha?version=new', { codigoCliente: CLIENTE_TICKET, codigoProduto: 4, tipoSenha: TIPO_SENHA, senha: String(senha) });
    },
    async criar(m) {
      return chamar('POST', '/ticketlog-servicos/ebs/motorista?version=new', { ...corpoTicket(m, { semValidade: true }), tipoSenha: TIPO_SENHA, senha: String(m.senhaTicket) });
    },
  };
}

// cria (sem id) ou atualiza (com id) o motorista na TruckPag
async function truckpag(io, m, { id, dataIso } = {}) {
  if (!/^\d{1,4}$/.test(String(m.senhaTruckpag ?? ''))) return { erro: 'senha TruckPag inválida (precisa ter de 1 a 4 números)' };   // nunca manda senha vazia
  const c = io.truckpag;
  const host = c.hosts.find((h) => /prd/.test(h)) || c.hosts[0];
  const r = await io.fetchCartao(host + '/api/integracao-clientes/motorista' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ empresa_id: EMPRESA_TRUCKPAG, nome: m.nome, motorista_senha: Number(m.senhaTruckpag), cpf: so(m.cpf),   // a TruckPag exige número inteiro (texto é recusado)
      motorista_data_nascimento: dataIso || isoDeBr(m.dataNascimento), status_id: 1 }) });
  const j = await r.json().catch(() => ({}));
  if (id && r.status >= 200 && r.status < 300) return { id };
  if (r.status === 201 && j.data && j.data.id) return { id: j.data.id };
  const erros = j.errors ? Object.values(j.errors).flat().join(' ') : j.message || 'HTTP ' + r.status;
  return { erro: erros.slice(0, 300) };
}

const semVazios = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== null && v !== undefined && v !== ''));

export async function criarNovos(io) {
  const { api, log } = io;
  if (!io.chaves.criar) return;
  const { motoristas } = await api('GET', '/api/sync/cadastros/novos-motoristas');
  if (!motoristas.length) return;
  const estado = await io.ler('motoristas-novos', {}), limpar = [], itens = [];
  // motorista de teste ou já criado nos dois: só falta apagar os dados pessoais
  const pendentes = motoristas.filter((x) => {
    const e = estado[x.id] || {};
    if (ehTeste(x.dados) || (e.ticket && e.truckpag)) { limpar.push(x.id); return false; }
    return true;
  });
  // senhas e números vêm da planilha, pelo usuário (a fila de antes de 10/11/2026 tinha senhas mascaradas)
  const daPlanilha = pendentes.length ? new Map((await io.motoristas()).map((p) => [String(p.usuario || ''), p])) : new Map();
  const T = pendentes.length ? ticket(io) : null;
  for (const x of pendentes) {
    const e = estado[x.id] || {};
    const p = daPlanilha.get(String(x.dados.usuario || ''));
    if (!p) { log(`Cadastro x cartões: ${x.dados.nome} ainda não está na lista da planilha; tenta na próxima.`); continue; }
    const m = { ...x.dados, ...semVazios(p), ...semVazios(x.pessoais) };
    const cpf = so(m.cpf);
    if (cpf.length !== 11) { log(`Cadastro x cartões: ${m.nome} sem CPF no cadastro; não foi para os cartões.`); limpar.push(x.id); continue; }
    const senhaTicketOk = /^\d{4,6}$/.test(String(m.senhaTicket ?? '')), senhaTruckpagOk = /^\d{1,4}$/.test(String(m.senhaTruckpag ?? ''));
    if (!e.ticket && !senhaTicketOk) log(`Cadastro x cartões: ${m.nome} sem senha Ticket válida na planilha (só números); não foi para a Ticket.`);
    if (!e.truckpag && !senhaTruckpagOk) log(`Cadastro x cartões: ${m.nome} sem senha TruckPag válida na planilha (1 a 4 números); não foi para a TruckPag.`);
    const dados = {};
    if (!e.ticket && senhaTicketOk) {
      const ja = await T.codigo(cpf);
      const r = ja ? { sucesso: true, codigoEntidade: ja } : await T.criar(m);
      if (r.sucesso && r.codigoEntidade) { dados.codigoTicket = Number(r.codigoEntidade); e.ticket = ja ? 'já existia' : 'criado'; }
      else log(`Cadastro x cartões: Ticket não cadastrou ${m.nome}: ${String(r.mensagem || r.codigoErro || '').slice(0, 200)}`);
    }
    if (!e.truckpag && senhaTruckpagOk) {
      const r = await truckpag(io, m);
      if (r.id) { dados.idTruckpag = Number(r.id); e.truckpag = 'criado'; }
      else { log(`Cadastro x cartões: TruckPag não cadastrou ${m.nome}: ${r.erro}`); if (/cpf/i.test(r.erro) && /utiliz|existe|cadastr/i.test(r.erro)) e.truckpag = 'já existia'; }
    }
    estado[x.id] = e;
    if (Object.keys(dados).length) { itens.push({ usuario: String(x.dados.usuario), dados }); log(`Cadastro x cartões: ${m.nome} -> Ticket ${e.ticket || 'pendente'}, TruckPag ${e.truckpag || 'pendente'}.`); }
    if (e.ticket && e.truckpag) limpar.push(x.id);   // feito nos dois: os dados pessoais podem sair
  }
  if (itens.length || limpar.length) await api('POST', '/api/sync/cadastros/cartoes', { itens, limpar });
  for (const id of limpar) delete estado[id];
  await io.gravar('motoristas-novos', estado);
}

export async function editarTruckpag(io) {
  const { api, log } = io, chaves = io.chaves;
  if (!chaves.editar && !chaves.editarTicket) return;
  const est = await io.ler('motoristas-edicao', {});
  if (!est.desde) {   // primeira vez ligado: vale só para edições daqui em diante
    await io.gravar('motoristas-edicao', { desde: new Date(io.agora()).toISOString().slice(0, 19) + 'Z' });
    return;
  }
  const { edicoes } = await api('GET', '/api/sync/cadastros/editados-motoristas?desde=' + encodeURIComponent(est.desde));
  if (!edicoes.length) return;
  const T = ticket(io);
  const RELEVANTES = ['nome', 'senhaTruckpag'];
  const DA_TICKET = ['nome', 'matricula', 'senhaTicket'];
  const lista = edicoes.some((e) => RELEVANTES.concat(DA_TICKET).some((k) => k in e.dados)) ? await io.motoristas() : [];
  const limpar = [];
  for (const e of edicoes) {
    const usuario = String(e.chave || ''), m0 = lista.find((x) => String(x.usuario || '') === usuario);
    const pes = semVazios(e.pessoais), m = m0 ? { ...m0, ...pes } : null;
    if (e.pessoais) limpar.push(e.id);   // processada (deu certo ou não): os dados pessoais saem
    if (ehTeste({ usuario, nome: (m0 && m0.nome) || e.dados.nome })) { est.desde = e.aplicada_em; await io.gravar('motoristas-edicao', est); continue; }
    if (chaves.editarTicket && DA_TICKET.some((k) => k in e.dados)) {
      const codigo = m && m.codigoTicket;
      if (!codigo) log(`Cadastro x cartões: edição de ${m ? m.nome : 'motorista'} não foi para a Ticket (sem código Ticket no cadastro).`);
      else {
        const campos = Object.keys(e.dados).filter((k) => DA_TICKET.includes(k) && k !== 'senhaTicket');
        if (campos.length && !(pes.cpf && pes.dataNascimento)) log(`Cadastro x cartões: edição de ${m.nome} não foi para a Ticket (sem CPF e nascimento na edição).`);
        else if (campos.length) {
          const r = await T.alterar(Number(codigo), m);
          log(r.sucesso ? `Cadastro x cartões: ${m.nome} atualizado na Ticket (${campos.join(', ')}).`
            : `Cadastro x cartões: Ticket não aceitou a edição de ${m.nome}: ${String(r.mensagem || r.codigoErro || '').slice(0, 250)}`);
        }
        if ('senhaTicket' in e.dados && m.senhaTicket) {
          const r = await T.senha(Number(codigo), m.senhaTicket);
          log(r.sucesso ? `Cadastro x cartões: senha Ticket de ${m.nome} trocada.` : `Cadastro x cartões: Ticket não trocou a senha de ${m.nome}: ${String(r.mensagem || r.codigoErro || '').slice(0, 250)}`);
        }
      }
    }
    if (chaves.editar && RELEVANTES.some((k) => k in e.dados)) {
      const dataIso = isoDeBr(pes.dataNascimento);
      if (!m || !m.idTruckpag) log(`Cadastro x cartões: edição de ${m ? m.nome : 'motorista'} não foi para a TruckPag (sem ID TruckPag no cadastro).`);
      else if (!/^\d{1,4}$/.test(String(m.senhaTruckpag || ''))) log(`Cadastro x cartões: edição de ${m.nome} não foi para a TruckPag (a senha TruckPag do cadastro precisa ter de 1 a 4 números).`);
      else if (!so(pes.cpf) || !dataIso) log(`Cadastro x cartões: edição de ${m.nome} não foi para a TruckPag (CPF e nascimento não foram informados na edição).`);
      else {
        const r = await truckpag(io, m, { id: Number(m.idTruckpag), dataIso });
        log(r.id ? `Cadastro x cartões: ${m.nome} atualizado na TruckPag (${Object.keys(e.dados).filter((k) => RELEVANTES.includes(k)).join(', ')}).`
          : `Cadastro x cartões: TruckPag não aceitou a edição de ${m.nome}: ${r.erro}`);
      }
    }
    est.desde = e.aplicada_em;   // processada (deu certo ou não): não repete
    await io.gravar('motoristas-edicao', est);
  }
  if (limpar.length) await api('POST', '/api/sync/cadastros/cartoes', { itens: [], limpar });
}

// ---------- placas: a unidade do cadastro vira o centro de custo do veículo na TruckPag ----------
const EMPRESA_TRUCKPAG_PLACAS = 25298;
const chave = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const soPlaca = (s) => chave(s).replace(/[^A-Z0-9]/g, '');

export function truckpagPlacas(io) {
  const c = io.truckpag;
  const host = c.hosts.find((h) => /prd/.test(h)) || c.hosts[0];
  const req = async (metodo, p, corpo) => {
    const r = await io.fetchCartao(host + p, { method: metodo, signal: AbortSignal.timeout(60_000),
      headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined });
    return { status: r.status, j: await r.json().catch(() => null) };
  };
  const lista = (j) => (Array.isArray(j) ? j : (j && j.data) || []);
  return {
    async centros() {
      const { status, j } = await req('GET', '/api/integracao-clientes/veiculo/centro-de-custo?empresa_id=' + EMPRESA_TRUCKPAG_PLACAS);
      if (status !== 200) throw new Error('TruckPag: centros de custo HTTP ' + status);
      return new Map(lista(j).map((x) => [chave(x.nome), { id: x.id ?? x.centro_de_custo_id, nome: x.nome }]));
    },
    async veiculos() {
      const { status, j } = await req('GET', '/api/integracao-clientes/veiculo');
      if (status !== 200) throw new Error('TruckPag: veículos HTTP ' + status);
      return new Map(lista(j).map((v) => [soPlaca(v.placa), v]));
    },
    async trocarCentro(veiculoId, centroId) {
      const { status, j } = await req('PUT', '/api/integracao-clientes/veiculo/' + veiculoId, { centro_custo_id: centroId });
      const v = j && (j.data || j);
      if (status >= 200 && status < 300 && v && v.centro_de_custo_id === centroId) return { ok: true };
      const erros = j && j.errors ? Object.values(j.errors).flat().join(' ') : (j && j.message) || 'HTTP ' + status;
      return { ok: false, erro: String(erros).slice(0, 250) };
    },
  };
}

// uma placa: unidade do cadastro -> centro de custo da TruckPag
export async function aplicar(T, centros, veiculos, placa, unidade, gravar) {
  const v = veiculos.get(soPlaca(placa)), cc = centros.get(chave(unidade));
  if (!v) return { placa, msg: 'não está na TruckPag', pulou: true };
  if (!cc) return { placa, msg: `a unidade ${unidade} não existe como centro de custo na TruckPag`, pulou: true };
  if (v.centro_de_custo_id === cc.id) return { placa, msg: 'já está com ' + cc.nome, igual: true };
  const de = v.centro_de_custo_nome || '(vazio)';
  if (!gravar) return { placa, msg: `${de} -> ${cc.nome} (não gravado)` };
  const r = await T.trocarCentro(v.veiculo_id, cc.id);
  if (r.ok) { v.centro_de_custo_id = cc.id; v.centro_de_custo_nome = cc.nome; }
  return { placa, ok: r.ok, msg: r.ok ? `${de} -> ${cc.nome}` : 'TruckPag não aceitou: ' + r.erro };
}

// ---------- vigia ----------
export async function processarPlacas(io) {
  const { api, log } = io;
  if (!io.chaves.placasUnidade) return;
  const est = await io.ler('placas', {});
  if (!est.desde) {   // primeira vez ligado: vale só para edições daqui em diante
    await io.gravar('placas', { desde: new Date(io.agora()).toISOString().slice(0, 19) + 'Z' });
    return;
  }
  const { edicoes } = await api('GET', '/api/sync/cadastros/editados-placas?desde=' + encodeURIComponent(est.desde));
  const comUnidade = edicoes.filter((e) => e.dados && e.dados.unidade);
  if (comUnidade.length) {
    const T = truckpagPlacas(io);
    const [centros, veiculos] = await Promise.all([T.centros(), T.veiculos()]);
    for (const e of comUnidade) {
      const r = await aplicar(T, centros, veiculos, e.dados.placa || e.chave, e.dados.unidade, true);
      if (!r.igual) log(`Placas x TruckPag: ${r.placa}: ${r.msg}.`);
    }
  }
  if (edicoes.length) {   // processadas (deram certo ou não): não repete
    est.desde = edicoes[edicoes.length - 1].aplicada_em;
    await io.gravar('placas', est);
  }
}

