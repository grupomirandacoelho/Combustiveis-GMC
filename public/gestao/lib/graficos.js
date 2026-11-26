// Gráfico por período (SVG): colunas opcionais + linhas, com dica ao passar o mouse e setas do teclado.
import { esc, fmt, dataParaDia, mesDoDia } from './dados.js';

// o período ainda está em andamento? (o último ponto de um gráfico com o mês/semana/dia de hoje: fica marcado, para a queda
// ou o número menor não parecer real — 10/11/2026). tipo: 'dia' (chave = dia), 'semana' (chave = domingo), 'mes' (chave = mês)
export function emAndamento(tipo, chave) {
  const hoje = dataParaDia(new Date());
  return tipo === 'dia' ? chave >= hoje : tipo === 'semana' ? hoje < chave + 7 : chave >= mesDoDia(hoje);
}
import { faixaMeta, metaHtml } from './filtros.js';

// linha suave do Figma: troca os segmentos retos ("M x y L x y ...") por curvas monotônicas (Fritsch-Carlson): a curva
// passa por todos os pontos e nunca ultrapassa um vale ou pico de verdade (não "afunda" abaixo de zero, por exemplo).
// Cada trecho com falha de dado (novo "M") é suavizado à parte.
export function suavizar(d) {
  const trechos = String(d).split('M').map((t) => t.trim()).filter(Boolean)
    .map((t) => t.split('L').map((p) => p.trim().split(/\s+/).map(Number)));
  const f = (v) => v.toFixed(1);
  return trechos.map((ps) => {
    const n = ps.length;
    if (n < 3) return 'M' + ps.map((p) => f(p[0]) + ' ' + f(p[1])).join(' L');
    const dl = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) dl.push((ps[i + 1][1] - ps[i][1]) / ((ps[i + 1][0] - ps[i][0]) || 1));
    m[0] = dl[0]; m[n - 1] = dl[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = dl[i - 1] * dl[i] <= 0 ? 0 : (dl[i - 1] + dl[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (dl[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / dl[i], b = m[i + 1] / dl[i], s2 = a * a + b * b;
      if (s2 > 9) { const t = 3 / Math.sqrt(s2); m[i] = t * a * dl[i]; m[i + 1] = t * b * dl[i]; }
    }
    let s = 'M' + f(ps[0][0]) + ' ' + f(ps[0][1]);
    for (let i = 0; i < n - 1; i++) {
      const h = (ps[i + 1][0] - ps[i][0]) / 3;
      s += ' C' + f(ps[i][0] + h) + ' ' + f(ps[i][1] + m[i] * h) + ' ' + f(ps[i + 1][0] - h) + ' ' + f(ps[i + 1][1] - m[i + 1] * h) +
        ' ' + f(ps[i + 1][0]) + ' ' + f(ps[i + 1][1]);
    }
    return s;
  }).join(' ');
}

function ticks(min, max, alvo) {
  const passoBruto = (max - min) / alvo || 1;
  const pot = Math.pow(10, Math.floor(Math.log10(passoBruto)));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * pot).find((p) => p >= passoBruto) || pot * 10;
  const ini = Math.floor(min / passo) * passo, fim = Math.ceil(max / passo) * passo;
  const r = [];
  for (let v = ini; v <= fim + passo / 2; v += passo) r.push(+v.toFixed(6));
  return r;
}

/**
 * @param {Element} box
 * @param {Array} pts     [{rotulo, rotuloLongo, ...valores}]
 * @param {object} o
 * @param {{campo, rot, cor}} [o.barras]  série em colunas (começa no zero)
 * @param {Array<{campo, rot, cor, tracejada?, pontos?}>} o.linhas   pontos: marca cada período na linha mesmo com muitos períodos
 * @param {Function} o.fmtV    formata os valores das dicas e dos rótulos das colunas
 * @param {Function} [o.fmtEixo] formata o eixo vertical
 * @param {Function} [o.fmtRotulo] formato curto dos rótulos em cima das colunas (padrão: fmtV)
 * @param {Function} [o.extras] (p) => [[rótulo, texto]] linhas a mais na dica
 * @param {string} o.rotulo   descrição para leitor de tela
 * @param {boolean} [o.cortarPicos] escala pelo que é normal no período: o teto fica em 1,3 × o maior entre a linha
 *   (ex.: a meta) e o percentil 90 das colunas; a coluna acima do teto vai até o topo com uma marca e o valor real
 *   (ex.: km/L de um dia com um abastecimento pequeno, que dá 60 km/L e achatava os outros dias)
 * @param {Function} [o.barras.corDe] (p) => cor da coluna daquele ponto (senão o.barras.cor)
 * @param {boolean} [o.ultimoParcial] o último ponto ainda está em andamento (ex.: o dia de hoje): o trecho até ele sai
 *   tracejado e mais claro, para a queda não parecer real
 */
export function graficoPeriodo(box, pts, o) {
  const series = [...(o.barras ? [o.barras] : []), ...o.linhas];
  const tem = (v) => v !== null && v !== undefined;
  pts = pts.filter((p) => series.some((s) => tem(p[s.campo])));
  if (!pts.length) {
    box.removeAttribute('tabindex');
    box.innerHTML = '<div class="vazio">Nenhum dado neste recorte. Tire um filtro para ver o gráfico.</div>';
    return;
  }
  const W = Math.max(320, box.clientWidth), H = o.altura || 220;   // 220 (era 260): densidade dos painéis, 18/11/2026
  const m = { l: 44, r: 16, t: 20, b: 28 };
  const vals = pts.flatMap((p) => series.map((s) => p[s.campo]).filter(tem));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (o.barras) lo = Math.min(0, lo);
  let cortado = false;
  if (o.cortarPicos && o.barras) {
    const colunas = pts.map((p) => p[o.barras.campo]).filter(tem).sort((a, b) => a - b);
    const p90 = colunas.length ? colunas[Math.min(colunas.length - 1, Math.floor(colunas.length * 0.9))] : 0;
    const daLinha = Math.max(0, ...pts.flatMap((p) => o.linhas.map((s) => p[s.campo]).filter(tem)));
    const teto = Math.max(daLinha, p90) * 1.3;
    if (teto > 0 && hi > teto) { hi = teto; cortado = true; }
  }
  const folga = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1;
  const tk = ticks(o.barras ? lo : lo - folga, hi + folga, 4);
  lo = tk[0]; hi = tk[tk.length - 1];
  const n = pts.length;
  const faixa = (W - m.l - m.r) / n;
  const x = (i) => m.l + faixa * (i + 0.5);
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const passoX = Math.max(1, Math.ceil(n / Math.floor((W - m.l - m.r) / 56)));
  const larguraBarra = Math.max(4, Math.min(44, faixa * 0.62));
  const caminho = (campo) => pts.map((p, i) => (!tem(p[campo]) ? ''
    : (i && tem(pts[i - 1][campo]) ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[campo]).toFixed(1))).join(' ');
  // rótulo em cima das colunas só quando o texto mais longo cabe na largura de cada coluna (~7 px por caractere a 12 px)
  const maiorRotulo = o.barras ? Math.max(0, ...pts.map((p) => (tem(p[o.barras.campo]) ? String((o.fmtRotulo || o.fmtV)(p[o.barras.campo])).length : 0))) : 0;
  const rotulosBarra = o.barras && n <= 16 && faixa > 38 && maiorRotulo * 7 + 6 <= faixa;   // não cabe: só o último período leva o valor
  const fmtEixo = o.fmtEixo || fmt.d1;

  box.innerHTML =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(o.rotulo) + '">' +
      tk.map((v) => '<line x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--grade)" stroke-width="1"/>' +
        '<text class="eixo-txt num" x="' + (m.l - 8) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + esc(fmtEixo(v)) + '</text>').join('') +
      pts.map((p, i) => (i % passoX === 0 ? '<text class="eixo-txt" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(p.rotulo) + '</text>' : '')).join('') +
      (o.barras ? pts.map((p, i) => {
        const v = p[o.barras.campo];
        if (!tem(v)) return '';
        const passou = cortado && v > hi;   // acima do teto: vai até o topo, com a marca e o valor real
        const y0 = y(Math.max(lo, 0)), y1 = y(passou ? hi : v);
        const cor = (o.barras.corDe && o.barras.corDe(p)) || o.barras.cor;
        const xb = x(i) - larguraBarra / 2;
        return '<rect x="' + xb.toFixed(1) + '" y="' + Math.min(y0, y1).toFixed(1) + '" width="' + larguraBarra.toFixed(1) +
          '" height="' + Math.max(1, Math.abs(y0 - y1)).toFixed(1) + '" rx="4" fill="' + cor + '"' +
          (o.destacar && !o.destacar(p) ? ' opacity="0.3"' : o.ultimoParcial && i === n - 1 ? ' opacity="0.5" stroke="' + cor + '" stroke-width="1.5" stroke-dasharray="4 3"' : '') + '/>' +
          (passou ? '<path d="M' + xb.toFixed(1) + ' ' + (y1 + 9).toFixed(1) + ' l' + (larguraBarra / 2).toFixed(1) + ' -5 l' + (larguraBarra / 2).toFixed(1) + ' 5" fill="none" stroke="var(--superficie)" stroke-width="2.5"/>' +
            '<text class="rot-barra num" x="' + x(i) + '" y="' + (m.t - 6) + '" text-anchor="middle">▲ ' + esc((o.fmtRotulo || o.fmtV)(v)) + '</text>' : '') +
          ((rotulosBarra || (o.barras && n <= 16 && i === n - 1)) && !passou ? '<text class="rot-barra num" x="' + x(i) + '" y="' + (Math.min(y0, y1) - 5) + '" text-anchor="middle">' + esc((o.fmtRotulo || o.fmtV)(v)) + '</text>' : '');
      }).join('') : '') +
      o.linhas.map((s) => {
        const parcial = o.ultimoParcial && !s.tracejada && n > 2 && tem(pts[n - 1][s.campo]) && tem(pts[n - 2][s.campo]);
        const d = parcial ? suavizar(caminho(s.campo).replace(/\s*L[^ML]*$/, '')) : suavizar(caminho(s.campo));
        return '<path d="' + d + '" fill="none" stroke="' + s.cor + '" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"' +
          (s.tracejada ? ' stroke-dasharray="6 4"' : '') + '/>' +
          (parcial ? '<path d="M' + x(n - 2).toFixed(1) + ' ' + y(pts[n - 2][s.campo]).toFixed(1) + ' L' + x(n - 1).toFixed(1) + ' ' + y(pts[n - 1][s.campo]).toFixed(1) +
            '" fill="none" stroke="' + s.cor + '" stroke-width="2" stroke-dasharray="4 4" opacity="0.55" stroke-linecap="round"/>' +
            '<circle cx="' + x(n - 1) + '" cy="' + y(pts[n - 1][s.campo]) + '" r="3.5" fill="var(--superficie)" stroke="' + s.cor + '" stroke-width="2" opacity="0.7"/>' : '') +
        // pontos: sempre que a série pede (s.pontos) ou com poucos períodos; o último em andamento já tem o seu
        (n <= 12 || s.pontos ? pts.map((p, i) => (!tem(p[s.campo]) || (parcial && i === n - 1) ? ''
          : '<circle class="ponto-serie" cx="' + x(i) + '" cy="' + y(p[s.campo]) + '" r="' + (n <= 12 ? 3.5 : 3) + '" fill="var(--superficie)" stroke="' + s.cor + '" stroke-width="2"/>')).join('') : '');
      }).join('') +
      // faixa vertical no período apontado, como o destaque do gráfico do Figma
      '<rect class="cursor" y="' + m.t + '" width="26" height="' + (H - m.t - m.b) + '" rx="5" fill="var(--tinta)" opacity="0.12" style="display:none"/>' +
      '<rect x="' + m.l + '" y="0" width="' + (W - m.l - m.r) + '" height="' + H + '" fill="transparent" class="alvo"/>' +
    '</svg><div class="dica oculto"></div>';

  const svg = box.querySelector('svg'), cursor = svg.querySelector('.cursor'), dica = box.querySelector('.dica');
  function mostrar(i) {
    const p = pts[i];
    cursor.style.display = '';
    cursor.setAttribute('x', x(i) - 13);
    dica.innerHTML = '<strong>' + esc(p.rotuloLongo || p.rotulo) + (o.ultimoParcial && i === n - 1 ? ' · em andamento' : '') + '</strong>' +
      series.map((s) => '<div class="linha-dica"><span><i style="background:' + s.cor + '"></i>' + esc(s.rot) + '</span><b class="num">' + esc(o.fmtV(p[s.campo])) + '</b></div>').join('') +
      (o.extras ? o.extras(p).map(([r, t]) => '<div class="linha-dica"><span>' + esc(r) + '</span><b class="num">' + esc(t) + '</b></div>').join('') : '');
    dica.classList.remove('oculto');
    const escala = box.clientWidth / W;
    let left = x(i) * escala + 14;
    if (left + dica.offsetWidth > box.clientWidth) left = x(i) * escala - dica.offsetWidth - 14;
    dica.style.left = Math.max(0, left) + 'px';
    dica.style.top = '8px';
  }
  const esconder = () => { cursor.style.display = 'none'; dica.classList.add('oculto'); };
  let atual = n - 1;
  const alvo = svg.querySelector('.alvo');
  const indice = (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    return Math.max(0, Math.min(n - 1, Math.floor((px - m.l) / faixa)));
  };
  alvo.addEventListener('mousemove', (e) => { atual = indice(e); mostrar(atual); });
  alvo.addEventListener('mouseleave', esconder);
  // clique (ou Enter) num período: quem desenhou o gráfico decide o que fazer (ex.: filtrar o painel por ele)
  if (o.aoClicar) {
    alvo.style.cursor = 'pointer';
    // a coluna vem da posição do clique (no toque do celular não há "mousemove" antes)
    alvo.addEventListener('click', (e) => { atual = indice(e); o.aoClicar(pts[atual], e); });   // e: Ctrl/Cmd para somar à seleção
  }
  box.tabIndex = 0;
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', o.rotulo + '. Use as setas para percorrer os períodos' + (o.aoClicar ? ' e Enter para filtrar pelo período.' : '.'));
  box.onfocus = () => mostrar(atual);
  box.onblur = esconder;
  box.onkeydown = (e) => {
    if (o.aoClicar && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); o.aoClicar(pts[atual]); return; }
    if (e.key === 'ArrowLeft') { atual = Math.max(0, atual - 1); mostrar(atual); e.preventDefault(); }
    if (e.key === 'ArrowRight') { atual = Math.min(n - 1, atual + 1); mostrar(atual); e.preventDefault(); }
  };
}

// medidor da meta (meio círculo do Figma): média km/L contra a meta, com a marca da meta no arco
export function htmlMedidor(media, meta, statusHtml) {
  if (media === null || meta === null) return '<p class="vazio">Nenhum abastecimento com meta cadastrada neste recorte. Tire um filtro para ver a média.</p>';
  const pct = media / meta, dif = pct - 1;
  const topo = Math.ceil(Math.max(media, meta) * 1.2 * 2) / 2;
  const pMedia = Math.min(1, media / topo), pMeta = Math.min(1, meta / topo);
  const ponto = (p, r) => [100 - r * Math.cos(Math.PI * p), 100 - r * Math.sin(Math.PI * p)].map((v) => v.toFixed(1));
  const [m1x, m1y] = ponto(pMeta, 66), [m2x, m2y] = ponto(pMeta, 94), [tx, ty] = ponto(pMeta, 120);
  const arco = 'M20 100 A80 80 0 0 1 180 100';
  const classe = faixaMeta(pct);   // cor do arco pela faixa do % da meta
  return '<div class="medidor-arco" role="img" aria-label="Média ' + fmt.d2(media) + ' km/L; meta ' + fmt.d2(meta) + ' km/L; ' + fmt.pct(pct) + ' da meta">' +
      '<svg viewBox="0 -14 200 120" aria-hidden="true">' +
        '<path class="arco-fundo" d="' + arco + '" pathLength="100"/>' +
        '<path class="arco-valor ' + classe + '" d="' + arco + '" pathLength="100" stroke-dasharray="' + (pMedia * 100).toFixed(2) + ' 100"/>' +
        '<line class="arco-meta" x1="' + m1x + '" y1="' + m1y + '" x2="' + m2x + '" y2="' + m2y + '"/>' +
        '<text class="eixo-txt" x="' + tx + '" y="' + ty + '" text-anchor="middle" dominant-baseline="middle" fill="var(--suave)" font-size="12">Meta</text>' +
      '</svg>' +
      '<div class="medidor-centro"><span class="grande num">' + fmt.d2(media) + '</span><span class="uni">km/L</span></div>' +
    '</div>' +
    // abaixo do arco (26/11/2026): dentro dele a linha encostava nas pontas do arco
    '<p class="medidor-sub">' + fmt.pct(pct) + ' da meta de ' + fmt.d2(meta) + ' km/L</p>' +
    '<p class="medidor-status">' + metaHtml(pct, fmt.pct(Math.abs(dif)) + (dif >= 0 ? ' acima da meta' : ' abaixo da meta')) + '</p>';
}
