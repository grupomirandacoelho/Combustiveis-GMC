// Toque longo = Ctrl+clique no celular (26/11/2026, pedido do usuário: "no app, como não temos o CTRL + clique para selecionar mais
// de um abastecimento nos dashboards, ao apertar e segurar selecionar igual funciona no navegador").
// Segurar o dedo ~0,5 s sobre uma linha, coluna de gráfico, bolha do mapa etc. dispara um clique com ctrlKey (as telas já tratam
// o Ctrl+clique como "somar à seleção": Operação por motorista, Programa PRIME, Real x Orçado, Mapa de calor...). O toque solto
// que vem depois é ignorado, e o menu do navegador (copiar, abrir link) não abre. Só dentro da página (#pagina), só no toque.
export const ESPERA_MS = 500, TOLERANCIA_PX = 10;

export function iniciarToqueLongo(raiz, { espera = ESPERA_MS, vibrar = true } = {}) {
  if (!raiz) return () => {};
  let timer = null, inicio = null, disparouEm = 0;
  const cancelar = () => { clearTimeout(timer); timer = null; inicio = null; };
  const aoTocar = (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary || e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    cancelar();
    inicio = { x: e.clientX, y: e.clientY, alvo: e.target };
    timer = setTimeout(() => {
      const t = inicio;
      cancelar();
      if (!t || !t.alvo.isConnected) return;
      disparouEm = Date.now();
      if (vibrar && navigator.vibrate) navigator.vibrate(20);
      t.alvo.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, ctrlKey: true, clientX: t.x, clientY: t.y }));
    }, espera);
  };
  const aoMover = (e) => {
    if (inicio && (Math.abs(e.clientX - inicio.x) > TOLERANCIA_PX || Math.abs(e.clientY - inicio.y) > TOLERANCIA_PX)) cancelar();
  };
  // o clique "de verdade" que o navegador manda ao soltar o dedo depois do toque longo não conta (senão desfaria a seleção)
  const aoClicar = (e) => {
    if (e.isTrusted && disparouEm && Date.now() - disparouEm < 800) { e.preventDefault(); e.stopPropagation(); disparouEm = 0; }
  };
  const aoMenu = (e) => { if (inicio || (disparouEm && Date.now() - disparouEm < 800)) e.preventDefault(); };
  raiz.addEventListener('pointerdown', aoTocar, { passive: true });
  raiz.addEventListener('pointermove', aoMover, { passive: true });
  raiz.addEventListener('pointerup', cancelar, { passive: true });
  raiz.addEventListener('pointercancel', cancelar, { passive: true });
  raiz.addEventListener('click', aoClicar, true);
  raiz.addEventListener('contextmenu', aoMenu, true);
  return () => {
    cancelar();
    raiz.removeEventListener('pointerdown', aoTocar);
    raiz.removeEventListener('pointermove', aoMover);
    raiz.removeEventListener('pointerup', cancelar);
    raiz.removeEventListener('pointercancel', cancelar);
    raiz.removeEventListener('click', aoClicar, true);
    raiz.removeEventListener('contextmenu', aoMenu, true);
  };
}
