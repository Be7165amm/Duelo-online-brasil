const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ===== CONFIG =====
const MP_TOKEN = process.env.MP_ACCESS_TOKEN; // coloque no Render
const PAID = {
  d100: { gems: 100, valor: 2 },
  d600: { gems: 600, valor: 10 },
  d1500: { gems: 1500, valor: 20 },
  d4000: { gems: 4000, valor: 50 },
};

// Banco em memória (Render free apaga se reiniciar - para produção use banco real)
// playerId -> [{id, gems, pago}]
const db = new Map(); 
const pagamentos = new Map(); // paymentId MercadoPago -> {playerId, pacote, gems, pago}

app.get('/', (req, res) => res.send('Servidor Duelo Online no ar!'));

app.get('/saude', (req, res) => {
  res.json({ 
    ok: true, 
    mp: !!MP_TOKEN,
    hora: new Date().toISOString()
  });
});

// Criar Pix
app.post('/criar', async (req, res) => {
  try {
    const { playerId, pacote } = req.body;
    if (!playerId || !pacote || !PAID[pacote]) return res.status(400).json({ erro: 'pacote inválido' });
    if (!MP_TOKEN) return res.status(500).json({ erro: 'servidor sem chave do Mercado Pago' });

    const item = PAID[pacote];
    
    // Chama Mercado Pago
    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${MP_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': `${playerId}-${pacote}-${Date.now()}`
      },
      body: JSON.stringify({
        transaction_amount: item.valor,
        description: `Duelo Online - ${item.gems} diamantes - ${playerId}`,
        payment_method_id: 'pix',
        payer: { email: 'cliente@duelo.online', first_name: 'Jogador', last_name: 'Duelo' },
        external_reference: `${playerId}|${pacote}`,
        notification_url: `https://${req.get('host')}/webhook` // opcional
      })
    });

    const mpData = await mpRes.json();
    if (!mpRes.ok) {
      console.error('MP erro', mpData);
      return res.status(400).json({ erro: mpData.message || 'erro no Mercado Pago' });
    }

    const copiaECola = mpData.point_of_interaction?.transaction_data?.qr_code;
    const id = String(mpData.id);

    pagamentos.set(id, {
      playerId,
      pacote,
      gems: item.gems,
      valor: item.valor,
      pago: false,
      mpId: id,
      created: Date.now()
    });

    res.json({
      id,
      copiaECola,
      qr_code_base64: mpData.point_of_interaction?.transaction_data?.qr_code_base64
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'erro interno: ' + e.message });
  }
});

// Verificar créditos do jogador
app.get('/creditos', async (req, res) => {
  const { playerId } = req.query;
  if (!playerId) return res.status(400).json({ erro: 'sem playerId' });

  // Se tiver webhook, já estaria pago. Como não temos certeza, checa no MP os pendentes
  for (let [id, info] of pagamentos) {
    if (info.playerId === playerId && !info.pago) {
      try {
        const check = await fetch(`https://api.mercadopago.com/v1/payments/${id}`, {
          headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
        });
        const data = await check.json();
        if (data.status === 'approved') {
          info.pago = true;
          // adiciona no db do jogador
          if (!db.has(playerId)) db.set(playerId, []);
          db.get(playerId).push({ id, gems: info.gems, confirmado: false, pagoEm: Date.now() });
        }
      } catch {}
    }
  }

  const itens = (db.get(playerId) || []).filter(x => !x.confirmado);
  res.json({ itens });
});

// Confirmar entrega no jogo
app.post('/confirmar', (req, res) => {
  const { playerId, ids } = req.body;
  if (!playerId || !Array.isArray(ids)) return res.status(400).json({ erro: 'dados inválidos' });
  const lista = db.get(playerId) || [];
  lista.forEach(item => {
    if (ids.includes(String(item.id))) item.confirmado = true;
  });
  res.json({ ok: true });
});

// Webhook do Mercado Pago (se configurar)
app.post('/webhook', express.json(), async (req, res) => {
  try {
    const { data } = req.body;
    if (data?.id) {
      const check = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
        headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
      });
      const mp = await check.json();
      if (mp.status === 'approved') {
        const ref = pagamentos.get(String(mp.id));
        if (ref) {
          ref.pago = true;
          if (!db.has(ref.playerId)) db.set(ref.playerId, []);
          // evita duplicar
          const ja = db.get(ref.playerId).some(x => String(x.id) === String(mp.id));
          if (!ja) db.get(ref.playerId).push({ id: String(mp.id), gems: ref.gems, confirmado: false });
        }
      }
    }
  } catch(e){ console.error('webhook err', e) }
  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Rodando na porta', PORT));
