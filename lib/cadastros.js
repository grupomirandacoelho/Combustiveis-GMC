// Cadastros de placas e motoristas: planilha CONTROLES\Controle_motoristas_e_placas.xlsx (abas "Carros" e "Motoristas").
// O vigia publica a lista na chave "cadastros" do KV. As alterações feitas no portal ficam na tabela
// alteracoes_cadastros até o vigia gravá-las na planilha (scripts/planilha_cadastros.py).
// Os campos abaixo são a fonte única: a tela monta a tabela e o formulário a partir deles.

// tipo: texto | placa | cpf | senha | inteiro | decimal | data (dd/mm/aaaa) | opcao | calculado (fórmula da planilha, só
// leitura) | leitura (preenchido pelas APIs dos cartões; o portal não edita)
// obrigatorioNovo: obrigatório só ao adicionar (os cartões exigem para cadastrar; os antigos ficam como estão)
export const CAMPOS = {
  placas: [
    { id: 'placa', rotulo: 'Placa', tipo: 'placa', obrigatorio: true },
    { id: 'categoria', rotulo: 'Categoria', tipo: 'texto', obrigatorio: true, sugestoes: true, max: 30 },
    { id: 'unidade', rotulo: 'Unidade', tipo: 'texto', obrigatorio: true, sugestoes: true, max: 60 },
    { id: 'marca', rotulo: 'Marca', tipo: 'texto', sugestoes: true, max: 30 },
    { id: 'modelo', rotulo: 'Modelo', tipo: 'texto', max: 40 },
    { id: 'ano', rotulo: 'Ano', tipo: 'inteiro', min: 1950, max: 2100 },
    { id: 'meta', rotulo: 'Meta (km/L)', tipo: 'decimal', min: 0, max: 30 },
    { id: 'pontoCritico', rotulo: 'Ponto crítico (km/L)', tipo: 'calculado', explica: 'meta − 0,5' },
    { id: 'capTanque', rotulo: 'Capacidade do tanque (L)', tipo: 'decimal', min: 0, max: 3000 },
    { id: 'autonomia', rotulo: 'Autonomia com margem (km)', tipo: 'calculado', explica: 'tanque × meta × 0,75' },
    // coluna K da aba Carros (criada pelo vigia na primeira gravação); vazio na planilha = ATIVA. VENDIDO desde 17/11/2026
    // (antes ficava "VENDA" na unidade e na categoria): vendido e desabilitado ficam fora dos cartões e das listas de placas
    { id: 'situacao', rotulo: 'Situação', tipo: 'opcao', opcoes: ['ATIVA', 'DESABILITADA', 'VENDIDO'], padrao: 'ATIVA' },
  ],
  motoristas: [
    { id: 'nome', rotulo: 'Motorista', tipo: 'texto', obrigatorio: true, max: 80 },
    // selecao: no formulário vira lista suspensa com as unidades da planilha (+ "Outra…" para digitar uma nova)
    { id: 'unidade', rotulo: 'Unidade', tipo: 'texto', obrigatorio: true, sugestoes: true, selecao: true, max: 60 },
    // login da área do motorista: os 6 primeiros números do CPF (eram a senha até 12/11/2026). O CPF não fica guardado:
    // o servidor tira o usuário do CPF digitado no cadastro novo (ou sorteia outro, se já for de alguém)
    { id: 'usuario', rotulo: 'Usuário', tipo: 'leitura', explica: 'Login da área do motorista (6 primeiros números do CPF). A senha inicial é o mesmo número' },
    { id: 'senhaTicket', rotulo: 'Senha Ticket', tipo: 'senha' },
    { id: 'senhaTruckpag', rotulo: 'Senha TruckPag', tipo: 'senha' },
    { id: 'senhaVeloe', rotulo: 'Senha Veloe', tipo: 'senha' },
    // vazio ao adicionar = ATIVO (sem situação o motorista novo ficava fora do filtro "Situação: ATIVO")
    { id: 'situacao', rotulo: 'Situação', tipo: 'opcao', opcoes: ['ATIVO', 'AFASTADO', 'FÉRIAS', 'DESLIGADO'], padrao: 'ATIVO' },
    // matrícula da Ticket = senha Ticket (149 de 150 no cadastro): oculta (fora da tabela e do formulário), o servidor grava
    // junto sempre que a senha Ticket é informada (validar)
    { id: 'matricula', rotulo: 'Matrícula', tipo: 'inteiro', min: 1, max: 999999999, oculto: true },
    // números internos dos cartões (não são a senha): o vigia preenche e usa para editar/cadastrar pela API
    { id: 'codigoTicket', rotulo: 'Código Ticket', tipo: 'leitura', oculto: true, explica: 'Número interno do motorista na Ticket. Preenchido pela API' },
    { id: 'idTruckpag', rotulo: 'ID TruckPag', tipo: 'leitura', oculto: true, explica: 'Número interno do motorista na TruckPag. Preenchido pela API' },
  ],
};
// motorista novo: senhas dos cartões obrigatórias (a TruckPag só aceita 1 a 4 números)
for (const id of ['senhaTicket', 'senhaTruckpag']) CAMPOS.motoristas.find((c) => c.id === id).obrigatorioNovo = true;
export const CHAVE = { placas: 'placa', motoristas: 'usuario' };

// Dados pessoais: o formulário pede só para mandar à Ticket e à TruckPag (cadastro novo, ou edição repetida na TruckPag).
// Não vão para a planilha nem para a lista: ficam em alteracoes_cadastros.pessoais até o vigia enviar e são apagados.
export const PESSOAIS = [
  { id: 'cpf', rotulo: 'CPF', tipo: 'cpf' },
  { id: 'dataNascimento', rotulo: 'Data de nascimento', tipo: 'data' },
  // da CNH só a categoria (27/11/2026, pedido do usuário): a Ticket recusa o motorista novo sem ela ("ds_categoria_carteira");
  // número e validade não são pedidos (a validade já não ia: a Ticket recusava o cadastro com ela)
  { id: 'cnhCategoria', rotulo: 'Categoria da CNH', pedir: 'Informe a categoria da CNH.', tipo: 'opcao', opcoes: ['A', 'B', 'C', 'D', 'E', 'AB', 'AC', 'AD', 'AE'] },
];
// obrigatórios no motorista novo com cartões (Ticket e TruckPag)
export const PESSOAIS_CARTOES = ['cpf', 'dataNascimento', 'cnhCategoria'];
export const TIPOS = Object.keys(CAMPOS);
export const NOME = { placas: 'placa', motoristas: 'motorista' };

const so = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
export const normalizarChave = (tipo, v) => (tipo === 'placas' ? so(v).toUpperCase().replace(/[^A-Z0-9]/g, '') : so(v).replace(/\D/g, ''));

function cpfValido(d) {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const dv = (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}

// valor digitado -> valor gravado na planilha (ou erro)
function converter(c, bruto) {
  const t = so(bruto);
  if (t === '' && c.padrao) return { v: c.padrao };
  if (t === '') return c.obrigatorio ? { erro: 'Informe ' + c.rotulo.toLowerCase() + '.' } : { v: null };
  switch (c.tipo) {
    case 'opcao': {
      // sem diferença de maiúsculas/acentos: "ferias" vira FÉRIAS
      const base = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
      const v = c.opcoes.find((o) => base(o) === base(t));
      return v ? { v } : { erro: c.rotulo + ': escolha ' + c.opcoes.slice(0, -1).join(', ') + ' ou ' + c.opcoes[c.opcoes.length - 1] + '.' };
    }
    case 'placa': {
      const p = t.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p) ? { v: p } : { erro: 'Placa inválida (ex.: ABC1D23 ou ABC1234).' };
    }
    case 'cpf': {
      const d = t.replace(/\D/g, '');
      if (!cpfValido(d)) return { erro: 'CPF inválido.' };
      return { v: d };
    }
    case 'senha':
      return /^[0-9A-Za-z]{1,12}$/.test(t) ? { v: t } : { erro: c.rotulo + ': use só letras e números (até 12).' };
    case 'data': {   // dd/mm/aaaa (ou aaaa-mm-dd, do campo de data) -> dd/mm/aaaa
      const br = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/), iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const [d, m, a] = br ? [br[1], br[2], br[3]].map(Number) : iso ? [iso[3], iso[2], iso[1]].map(Number) : [0, 0, 0];
      const dt = new Date(Date.UTC(a, m - 1, d));
      if (!d || dt.getUTCDate() !== d || dt.getUTCMonth() !== m - 1 || a < 1920 || a > 2100) return { erro: c.rotulo + ': use dd/mm/aaaa.' };
      return { v: String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + a };
    }
    case 'inteiro': {
      const n = Number(t);
      return Number.isInteger(n) && n >= c.min && n <= c.max ? { v: n } : { erro: c.rotulo + ' inválido.' };
    }
    case 'decimal': {
      const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);   // 1.234,5 ou 1234.5
      return Number.isFinite(n) && n >= c.min && n <= c.max ? { v: Math.round(n * 1000) / 1000 } : { erro: c.rotulo + ' inválido.' };
    }
    default:
      return { v: t.toUpperCase().slice(0, c.max || 80) };
  }
}

// {campo: valor digitado} -> {dados: só os campos editáveis enviados, convertidos; erros}
export function validar(tipo, acao, bruto) {
  const erros = [], dados = {};
  for (const c of CAMPOS[tipo]) {
    if (c.tipo === 'calculado' || c.tipo === 'leitura') continue;
    const exigido = c.obrigatorio || (acao === 'adicionar' && c.obrigatorioNovo);
    if (!(c.id in bruto) || (exigido && String(bruto[c.id] ?? '').trim() === '')) {
      if (acao === 'adicionar' && exigido) erros.push('Informe ' + c.rotulo.toLowerCase() + '.');
      if (c.id in bruto && c.obrigatorio && acao === 'editar') erros.push('Informe ' + c.rotulo.toLowerCase() + '.');
      continue;
    }
    const r = converter(c, bruto[c.id]);
    if (r.erro) erros.push(r.erro); else dados[c.id] = r.v;
    if (acao === 'adicionar' && c.id === 'senhaTruckpag' && r.v && !/^\d{1,4}$/.test(r.v)) erros.push('Senha TruckPag: de 1 a 4 números.');
  }
  if (!Object.keys(dados).length) erros.push('Nenhuma alteração para salvar.');
  // matrícula da Ticket = senha Ticket (o campo não aparece mais na tela)
  if (tipo === 'motoristas' && /^\d{1,9}$/.test(String(dados.senhaTicket ?? '')) && Number(dados.senhaTicket) >= 1) dados.matricula = Number(dados.senhaTicket);
  return { dados, erros };
}

// {campo: valor digitado} -> {pessoais: só o que veio preenchido (CPF só números), erros}. exigir: ids obrigatórios
export function validarPessoais(bruto, exigir = []) {
  const erros = [], pessoais = {};
  const b = bruto && typeof bruto === 'object' ? bruto : {};
  for (const c of PESSOAIS) {
    const t = String(b[c.id] ?? '').trim();
    if (!t) { if (exigir.includes(c.id)) erros.push(c.pedir || 'Informe ' + c.rotulo.toLowerCase() + '.'); continue; }
    const r = converter(c, t);
    if (r.erro) erros.push(r.erro); else if (r.v !== null) pessoais[c.id] = r.v;
  }
  return { pessoais, erros };
}
