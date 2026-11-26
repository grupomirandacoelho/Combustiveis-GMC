// Arrastar para o lado para fechar (celular, 18/11/2026): o painel de notificações sai arrastando para a direita, como o menu
// sai arrastando para a esquerda; os avisos do canto saem arrastando para qualquer lado. Mesmas regras do gesto do menu
// (gestao.js): começa com 12 px na horizontal e mais horizontal que vertical; sai com 30% da largura ou num arrasto rápido.
//   arrastarParaFechar(el, { direcoes: [1], ativo: () => celular.matches, aoSair: () => fechar(), esmaecer: false })

// dx = deslocamento em px (positivo = para a direita), ms = duração do arrasto, largura = largura do elemento
export function deveSair(dx, ms, largura, direcoes = [1]) {
  return direcoes.some((d) => { const v = dx * d; return v > largura * 0.3 || (v > 0 && v / Math.max(1, ms) > 0.5); });
}
// o arrasto só começa quando o movimento é claramente horizontal e para um lado permitido
export function comecaArrasto(dx, dy, direcoes = [1]) {
  return Math.abs(dx) >= 12 && Math.abs(dx) >= Math.abs(dy) * 1.5 && direcoes.some((d) => dx * d > 0);
}

export function arrastarParaFechar(el, { direcoes = [1], ativo = () => true, aoSair, esmaecer = false }) {
  let toque = null;
  const limite = (dx) => (direcoes.includes(1) ? (direcoes.includes(-1) ? dx : Math.max(0, dx)) : Math.min(0, dx));
  const soltar = () => { el.style.transition = ''; el.style.transform = ''; el.style.opacity = ''; };
  el.addEventListener('touchstart', (e) => {
    toque = ativo() && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), arrastando: false } : null;
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    if (!toque) return;
    const dx = e.touches[0].clientX - toque.x, dy = e.touches[0].clientY - toque.y;
    if (!toque.arrastando) {
      if (!comecaArrasto(dx, dy, direcoes)) { if (Math.abs(dy) > 12) toque = null; return; }
      toque.arrastando = true;
      el.style.transition = 'none';
    }
    const v = limite(dx);
    el.style.transform = 'translateX(' + v + 'px)';
    if (esmaecer) el.style.opacity = String(Math.max(0.2, 1 - Math.abs(v) / (el.getBoundingClientRect().width || 300)));
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const f = toque;
    toque = null;
    if (!f || !f.arrastando) return;
    const dx = ((e.changedTouches[0] || {}).clientX ?? f.x) - f.x, w = el.getBoundingClientRect().width || 300;
    if (deveSair(dx, Date.now() - f.t, w, direcoes)) {
      el.style.transition = 'transform .18s ease-in, opacity .18s ease-in';
      el.style.transform = 'translateX(' + (dx > 0 ? 110 : -110) + '%)';
      if (esmaecer) el.style.opacity = '0';
      setTimeout(() => { aoSair(); soltar(); }, 180);
    } else soltar();
  });
  el.addEventListener('touchcancel', () => { toque = null; soltar(); });
}
