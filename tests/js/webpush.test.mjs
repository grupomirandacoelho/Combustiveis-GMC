// Web Push sem biblioteca (lib/nuvem/webpush.js, 26/11/2026): um "aparelho" de teste decifra o que foi cifrado (lado do navegador,
// RFC 8291, feito aqui de forma independente) e confere a assinatura do VAPID (RFC 8292). Nada sai da máquina (fetch simulado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, deB64url, gerarVapid, cabecalhoVapid, cifrar, enviarPush, endpointValido } from '../../lib/nuvem/webpush.js';

const te = new TextEncoder();
const hmac = async (k, d) => new Uint8Array(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), d));
const junta = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };

// aparelho: par ECDH + segredo auth, como o navegador cria na inscrição
async function aparelho() {
  const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  return { par, inscricao: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64url(pub), auth: b64url(auth) } };
}
// decifra como o navegador (RFC 8291 seção 3/4)
async function decifrar(corpo, ap) {
  const sal = corpo.slice(0, 16), idlen = corpo[20], asPub = corpo.slice(21, 21 + idlen), cifrado = corpo.slice(21 + idlen);
  const rs = new DataView(corpo.buffer, corpo.byteOffset + 16, 4).getUint32(0);
  assert.equal(rs, 4096);
  const uaPub = deB64url(ap.inscricao.p256dh), auth = deB64url(ap.inscricao.auth);
  const as = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const seg = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, ap.par.privateKey, 256));
  const ikm = await hmac(await hmac(auth, seg), junta(te.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])));
  const prk = await hmac(sal, ikm);
  const cek = (await hmac(prk, junta(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, junta(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const claro = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, cifrado));
  assert.equal(claro[claro.length - 1], 2);   // delimitador do último registro
  return new TextDecoder().decode(claro.slice(0, -1));
}

test('webpush: o aparelho decifra a mensagem (acentos inclusive) e outra inscrição não', async () => {
  const ap = await aparelho(), outro = await aparelho();
  const msg = JSON.stringify({ titulo: 'Estoque baixo', texto: 'Diesel S10 da base JEQUIÉ com 1.850 L', url: '/gestao/#/bomba-estoque' });
  const corpo = await cifrar(msg, ap.inscricao);
  assert.equal(await decifrar(corpo, ap), msg);
  await assert.rejects(decifrar(corpo, { ...outro, inscricao: { ...outro.inscricao } }));
});

test('webpush: VAPID com aud do serviço de push, sub e assinatura válida pela chave pública', async () => {
  const v = await gerarVapid();
  assert.equal(deB64url(v.publica).length, 65);
  const h = await cabecalhoVapid('https://fcm.googleapis.com/fcm/send/xyz', { ...v, assunto: 'https://exemplo.pages.dev' }, 1000);
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, v.publica);
  const [c, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(deB64url(p))), { aud: 'https://fcm.googleapis.com', exp: 1000 + 43200, sub: 'https://exemplo.pages.dev' });
  const pub = await crypto.subtle.importKey('raw', deB64url(v.publica), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, deB64url(s), te.encode(c + '.' + p)));
});

test('webpush: envio com os cabeçalhos certos; 410 = inscrição expirada', async () => {
  const ap = await aparelho(), v = await gerarVapid(), pedidos = [];
  const fetchFn = async (url, op) => { pedidos.push({ url, op }); return { status: pedidos.length === 1 ? 201 : 410 }; };
  const a = await enviarPush(ap.inscricao, { titulo: 'x' }, { ...v, assunto: 'https://e.dev' }, { fetchFn, urgencia: 'high' });
  assert.deepEqual(a, { status: 201, ok: true, expirada: false });
  assert.equal(pedidos[0].url, ap.inscricao.endpoint);
  assert.equal(pedidos[0].op.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(pedidos[0].op.headers.Urgency, 'high');
  assert.equal(JSON.parse(await decifrar(pedidos[0].op.body, ap)).titulo, 'x');
  assert.equal((await enviarPush(ap.inscricao, { titulo: 'y' }, { ...v, assunto: 'https://e.dev' }, { fetchFn })).expirada, true);
});

test('webpush: só aceita endpoints dos serviços de push dos navegadores', () => {
  for (const e of ['https://fcm.googleapis.com/fcm/send/a', 'https://web.push.apple.com/QG', 'https://updates.push.services.mozilla.com/wpush/v2/x',
    'https://wns2-by3p.notify.windows.com/w/?token=1']) assert.ok(endpointValido(e), e);
  for (const e of ['http://fcm.googleapis.com/x', 'https://exemplo.com/push', 'https://googleapis.com.evil.com/x', null, 'https://fcm.googleapis.com.evil/x'])
    assert.ok(!endpointValido(e), String(e));
});

test('inscrição do aparelho: só serviço de push conhecido e chaves no formato certo; descrição sem caracteres estranhos', async () => {
  const { validarInscricao } = await import('../../functions/api/push/index.js');
  const ap = await aparelho();
  const ok = validarInscricao({ inscricao: { endpoint: ap.inscricao.endpoint, keys: { p256dh: ap.inscricao.p256dh, auth: ap.inscricao.auth } }, aparelho: 'Android · Chrome <b>' });
  assert.deepEqual(ok.valor, { endpoint: ap.inscricao.endpoint, p256dh: ap.inscricao.p256dh, auth: ap.inscricao.auth, aparelho: 'Android · Chrome b' });
  assert.ok(validarInscricao({ inscricao: { endpoint: 'https://exemplo.com/x', keys: { p256dh: ap.inscricao.p256dh, auth: ap.inscricao.auth } } }).erro);
  assert.ok(validarInscricao({ inscricao: { endpoint: ap.inscricao.endpoint, keys: { p256dh: 'curta', auth: ap.inscricao.auth } } }).erro);
  assert.ok(validarInscricao({}).erro);
});
