(function () {
  'use strict';
  // Tela de login (/), 26/11/2026: protótipo prototipos/login-v2 (HANDOFF.md) ligado ao POST /api/login. Um login para todos:
  // usuário de 6 números = motorista (vai para /motorista/: postos autorizados + média; 30 dias conectado); qualquer outro = gestão
  // (vai para /gestao/; "Manter conectado" = 48 h). Os postos autorizados saíram desta página (só com login, na área do motorista).
  // "Falta cartão no caminhão?" continua sem login (o mesmo formulário de antes).
  var $ = function (id) { return document.getElementById(id); };
  function guardar(chave, valor) {
    try { valor ? localStorage.setItem(chave, valor) : localStorage.removeItem(chave); } catch (e) {}
  }
  function ler(chave) { try { return localStorage.getItem(chave); } catch (e) { return null; } }

  // /gestao ou /motorista sem sessão mandam para /?entrar=1: aqui o formulário já é a página
  if (/[?&]entrar=1/.test(location.search)) history.replaceState(null, '', location.pathname);

  var form = $('form'), usuario = $('usuario'), senha = $('senha'), aviso = $('aviso');
  var ICONES = {
    erro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
    relogio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
  };
  // a mesma regra do servidor (lib/motoristas.js usuarioMotorista): só números, 6 (ou o CPF inteiro, 11, por costume)
  function ehUsuarioMotorista(s) {
    if (!/^[\d.\-\s]+$/.test(s)) return false;
    var d = s.replace(/\D/g, '');
    return d.length === 6 || d.length === 11;
  }

  var ehMotorista = false;
  var dicaLiberada = false;   // a regra do usuário do motorista só aparece depois de um erro
  function atualizarTipo() {
    ehMotorista = ehUsuarioMotorista(usuario.value.trim());
    $('tipo-conta').classList.toggle('oculto', !ehMotorista);
    $('dica-motorista').classList.toggle('oculto', !(ehMotorista && dicaLiberada));
    $('manter-rot').classList.toggle('oculto', ehMotorista);   // motorista já fica 30 dias conectado
    if (ehMotorista) $('manter').checked = false;
    senha.inputMode = ehMotorista ? 'numeric' : 'text';
    atualizarAjuda();
  }
  usuario.addEventListener('input', function () { $('campo-usuario').classList.remove('invalido'); esconderAviso(); atualizarTipo(); });
  senha.addEventListener('input', function () { $('campo-senha').classList.remove('invalido'); esconderAviso(); });
  ['keydown', 'keyup'].forEach(function (t) {
    senha.addEventListener(t, function (e) { if (e.getModifierState) $('caps').classList.toggle('ver', e.getModifierState('CapsLock')); });
  });
  senha.addEventListener('blur', function () { $('caps').classList.remove('ver'); });

  $('olho').addEventListener('click', function () {
    var ver = senha.type === 'password';
    senha.type = ver ? 'text' : 'password';
    $('olho').setAttribute('aria-pressed', String(ver));
    $('olho').setAttribute('aria-label', ver ? 'Esconder senha' : 'Mostrar senha');
    $('ic-olho').innerHTML = ver
      ? '<path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.7 17.7 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'
      : '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>';
    senha.focus();
  });

  function atualizarAjuda() {
    $('ajuda-senha').innerHTML = ehMotorista
      ? '<strong>Motorista:</strong> se você trocou a senha e esqueceu, peça à gestão de combustível para voltar à senha inicial.'
      : '<strong>Equipe de gestão:</strong> peça a um administrador do portal para gerar uma senha nova. No primeiro acesso você escolhe a sua.';
  }
  $('btn-esqueci').addEventListener('click', function () {
    var abrir = $('ajuda-senha').classList.contains('oculto');
    atualizarAjuda();
    $('ajuda-senha').classList.toggle('oculto', !abrir);
    $('btn-esqueci').setAttribute('aria-expanded', String(abrir));
  });

  function mostrarAviso(tipo, texto) {
    aviso.className = 'aviso surgir ' + tipo;
    aviso.innerHTML = (tipo === 'bloqueio' ? ICONES.relogio : ICONES.erro) + '<span></span>';
    aviso.querySelector('span').textContent = texto;
  }
  function esconderAviso() { aviso.className = 'aviso erro oculto'; }
  function carregando(sim) {
    $('btn-entrar').disabled = sim;
    $('btn-entrar').classList.toggle('carregando', sim);
    $('txt-entrar').textContent = sim ? 'Entrando…' : 'Entrar';
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    esconderAviso();
    var faltaU = !usuario.value.trim(), faltaS = !senha.value;
    $('campo-usuario').classList.toggle('invalido', faltaU);
    $('campo-senha').classList.toggle('invalido', faltaS);
    if (faltaU || faltaS) { (faltaU ? usuario : senha).focus(); return; }
    carregando(true);
    fetch('/api/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: usuario.value.trim(), senha: senha.value, manter: !ehMotorista && $('manter').checked })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok) {
          // login novo: os filtros guardados da sessão anterior começam limpos
          try { Object.keys(sessionStorage).filter(function (k) { return k.indexOf('filtros:') === 0; }).forEach(function (k) { sessionStorage.removeItem(k); }); } catch (e) {}
          location.href = res.d.motorista ? '/motorista/' : '/gestao/';
          return;
        }
        carregando(false);
        if (res.status === 429) mostrarAviso('bloqueio', res.d.erro || 'Muitas tentativas erradas. Tente de novo em alguns minutos.');
        else if (res.status === 401) {
          // motorista: a regra do usuário e da senha inicial aparece embaixo do campo
          mostrarAviso('erro', 'Usuário ou senha incorretos.');
          if (ehMotorista) { dicaLiberada = true; atualizarTipo(); }
          senha.select();
        } else mostrarAviso('erro', res.d.erro || 'Não foi possível entrar. Tente de novo.');
      })
      .catch(function () { carregando(false); mostrarAviso('erro', 'Sem conexão com o servidor. Verifique a internet e tente de novo.'); });
  });

  atualizarTipo();

  // ---------- aviso de cartão faltando no caminhão (vai para a gestão: Operacional > Cartões frota) ----------
  var dlgCartao = $('dialog-cartao'), formCartao = $('form-cartao');
  function erroCartao(msg) { $('erro-cartao').textContent = msg; $('erro-cartao').classList.toggle('oculto', !msg); }
  $('btn-cartao').addEventListener('click', function () {
    formCartao.reset();
    erroCartao('');
    formCartao.classList.remove('oculto');
    $('ok-cartao').classList.add('oculto');
    // placa e nome do último aviso feito neste celular já vêm preenchidos
    $('ac-placa').value = ler('aviso-placa') || '';
    $('ac-nome').value = ler('aviso-nome') || '';
    conferida = { placa: '', ok: false }; enviarAssimMesmo = '';
    mostrarSugestoes([], '');
    dlgCartao.showModal();
    ($('ac-placa').value ? formCartao.querySelector('input[name="cartao"]') : $('ac-placa')).focus();
  });
  $('cancelar-cartao').addEventListener('click', function () { dlgCartao.close(); });
  $('fechar-cartao').addEventListener('click', function () { dlgCartao.close(); });
  dlgCartao.addEventListener('click', function (e) { if (e.target === dlgCartao) dlgCartao.close(); });
  // sugestões de placa: o site procura no controle de cartões o que foi digitado (a partir de 3 caracteres),
  // aceitando placa antiga/Mercosul e erro de digitação; a placa que não está no controle pede confirmação ao enviar
  var tPlaca = null, conferida = { placa: '', ok: false }, enviarAssimMesmo = '';
  function buscarPlacas(q, depois) {
    fetch('/api/placas-aviso?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { depois(d); })
      .catch(function () { depois(null); });   // sem internet: não atrapalha o envio
  }
  function mostrarSugestoes(lista, texto) {
    var caixa = $('ac-sugestoes');
    if (!lista.length && !texto) { caixa.classList.add('oculto'); caixa.innerHTML = ''; return; }
    caixa.innerHTML = (texto ? '<p>' + texto + '</p>' : '') + lista.map(function (p) {
      return '<button type="button" class="sugestao-placa" data-placa="' + p + '">' + p + '</button>';
    }).join('');
    caixa.classList.remove('oculto');
  }
  function escolherPlaca(p) {
    $('ac-placa').value = p;
    conferida = { placa: p, ok: true };
    mostrarSugestoes([], '');
    erroCartao('');
    formCartao.querySelector('input[name="cartao"]').focus();
  }
  $('ac-sugestoes').addEventListener('click', function (e) {
    var b = e.target.closest('[data-placa]');
    if (b) escolherPlaca(b.getAttribute('data-placa'));
  });
  $('ac-placa').addEventListener('input', function (e) {
    var q = e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    clearTimeout(tPlaca);
    enviarAssimMesmo = '';
    if (q.length < 3) { mostrarSugestoes([], ''); return; }
    tPlaca = setTimeout(function () {
      buscarPlacas(q, function (d) {
        if (!d || $('ac-placa').value !== q) return;
        var exata = d.exata || d.controle === false;
        // placa antiga de um caminhão que está no controle com a Mercosul (ou o contrário): troca pela do controle
        if (d.exata && d.placa && d.placa !== q) {
          $('ac-placa').value = d.placa;
          conferida = { placa: d.placa, ok: true };
          mostrarSugestoes([], 'Placa trocada para ' + d.placa + ', como está no controle de cartões.');
          return;
        }
        conferida = { placa: q, ok: exata };
        var outras = (d.sugestoes || []).filter(function (p) { return p !== q; });
        if (exata) mostrarSugestoes([], '');
        else if (q.length >= 7) mostrarSugestoes(outras, outras.length ? 'Essa placa não está no controle. Você quis dizer:' : 'Essa placa não está no controle de cartões. Confira.');
        else mostrarSugestoes(outras, outras.length ? 'Toque na placa:' : '');
      });
    }, 250);
  });

  formCartao.addEventListener('submit', function (e) {
    e.preventDefault();
    var placa = $('ac-placa').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    var cartoes = [].map.call(formCartao.querySelectorAll('input[name="cartao"]:checked'), function (c) { return c.value; });
    var nome = $('ac-nome').value.trim();
    if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(placa)) { erroCartao('Confira a placa (ex.: ABC1D23 ou ABC1234).'); $('ac-placa').focus(); return; }
    if (!cartoes.length) { erroCartao('Marque qual cartão está faltando.'); formCartao.querySelector('input[name="cartao"]').focus(); return; }
    if (nome.length < 3) { erroCartao('Escreva o seu nome.'); $('ac-nome').focus(); return; }
    // placa fora do controle de cartões: mostra as parecidas; tocar em "Enviar aviso" de novo manda assim mesmo
    if (!(conferida.placa === placa && conferida.ok) && enviarAssimMesmo !== placa) {
      var btnC = $('enviar-cartao');
      btnC.disabled = true;
      buscarPlacas(placa, function (d) {
        btnC.disabled = false;
        if (!d || d.exata || d.controle === false) {
          if (d && d.placa) $('ac-placa').value = d.placa;   // a forma da placa que está no controle
          conferida = { placa: $('ac-placa').value, ok: true };
          $('enviar-cartao').click();
          return;
        }
        enviarAssimMesmo = placa;
        var outras = (d.sugestoes || []).filter(function (p) { return p !== placa; });
        mostrarSugestoes(outras, outras.length ? 'Você quis dizer:' : '');
        erroCartao('A placa ' + placa + ' não está no controle de cartões. ' + (outras.length ? 'Toque numa das placas abaixo ou' : 'Confira a placa ou') +
          ' toque em "Enviar aviso" de novo para mandar assim mesmo.');
        $('ac-placa').focus();
      });
      return;
    }
    erroCartao('');
    var btn = $('enviar-cartao');
    btn.disabled = true; btn.textContent = 'Enviando…';
    fetch('/api/alerta-cartao', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placa: placa, cartoes: cartoes, motorista: nome, observacao: $('ac-obs').value, site: formCartao.site.value })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) { erroCartao(res.d.erro || 'Não foi possível enviar. Tente de novo.'); return; }
        guardar('aviso-placa', placa);
        guardar('aviso-nome', nome);
        formCartao.classList.add('oculto');
        $('ok-cartao').classList.remove('oculto');
        $('fechar-cartao').focus();
      })
      .catch(function () { erroCartao('Sem internet agora. Tente de novo quando tiver sinal.'); })
      .then(function () { btn.disabled = false; btn.textContent = 'Enviar aviso'; });
  });

  // ---------- app instalável ----------
  // ---------- app instalável (o service worker também recebe as notificações no celular) ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function () {});
})();
