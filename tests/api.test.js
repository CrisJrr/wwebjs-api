require('dotenv').config();
const { sendToQueue } = require('./src/services/rabbitmqService');

// --- 1. MOCK (Imitação) das funções do WhatsApp ---
// Como não temos o "client" real aqui, criamos funções falsas só para ver o log
const triggerAllWebhooks = (session, event, body) => {
    console.log(`🌐 [HTTP MOCK] Enviando POST para o Webhook da sessão ${session}... (Sucesso)`);
};
const triggerWebSocket = () => {}; 
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- 2. A LÓGICA EXATA DO SEU ARQUIVO SESSIONS.JS ---
// Copiei sua lógica de decisão para encapsular nesta função de teste
async function processarMensagemSimulada(sessionId, messageFake) {
    console.log(`\n🎬 --- INICIANDO SIMULAÇÃO PARA: ${sessionId} ---`);

    // AQUI ESTÁ A LÓGICA QUE VOCÊ CRIOU:
    const envKey = 'SESSION_' + sessionId.toUpperCase() + '_WEBHOOK_URL';
    const specificUrl = process.env[envKey];

    console.log(`🔍 Buscando env: ${envKey}`);
    console.log(`🔗 Valor: ${specificUrl || 'UNDEFINED'}`);

    if (specificUrl) {
        console.log('✅ [DECISÃO] Tem Webhook -> Via HTTP');
        triggerAllWebhooks(sessionId, 'message', { message: messageFake });
    } else {
        console.log('⚠️ [DECISÃO] Sem Webhook -> Via RabbitMQ');
        try {
            // Payload igual ao real
            const rabbitPayload = {
                sessionId: sessionId,
                event: 'message',
                from: messageFake.from,
                body: messageFake.body,
                timestamp: new Date().toISOString(),
                simulacao: true
            };
            await sendToQueue(rabbitPayload);
        } catch (err) {
            console.error('❌ Erro no RabbitMQ:', err);
        }
    }
}

// --- 3. EXECUTANDO OS CENÁRIOS ---
async function rodarTestes() {
    console.log("🚀 INICIANDO SIMULADOR DE FLUXO DE DADOS");

    // CENÁRIO A: Sessão SEM Webhook (Deve ir para o RabbitMQ)
    // Garantimos que não existe variável para essa sessão
    delete process.env.SESSION_SESSAO_RABBIT_WEBHOOK_URL;
    
    await processarMensagemSimulada('sessao_rabbit', {
        from: '551199999999@c.us',
        body: 'Teste 1: Eu devo ir para a FILA 🐰',
        hasMedia: false
    });

    await sleep(1000); // Pausa dramática

    // CENÁRIO B: Sessão COM Webhook (Deve ir via HTTP e ignorar fila)
    // Injetamos uma variável fake na memória deste processo
    process.env.SESSION_SESSAO_HTTP_WEBHOOK_URL = 'https://webhook.site/teste-fake';
    
    await processarMensagemSimulada('sessao_http', {
        from: '551188888888@c.us',
        body: 'Teste 2: Eu devo ir para o WEBHOOK 🌐',
        hasMedia: false
    });

    console.log("\n🏁 Simulação finalizada. Verifique seu painel do RabbitMQ.");
    // Espera um pouco pro buffer do Rabbit esvaziar antes de fechar
    setTimeout(() => process.exit(0), 1000);
}

rodarTestes();