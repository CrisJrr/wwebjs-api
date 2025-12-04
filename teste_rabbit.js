// teste_rabbit.js
require("dotenv").config(); // Carrega as variáveis do .env (login admin/admin)
const { sendToQueue } = require('./src/services/rabbitmqService'); // Ajuste o caminho se necessário

async function testarEnvio() {
    console.log("Iniciando teste de envio simulado...");

    // Payload igual ao que o WhatsApp enviaria
    const payloadFake = {
        sessionId: "session-teste",
        event: "message",
        from: "5511999999999@c.us",
        to: "5511888888888@c.us",
        body: "Olá! Isso é uma simulação via script Node.js",
        hasMedia: false,
        timestamp: new Date().toISOString(),
        deviceType: "android",
        isGroup: false
    };

    console.log("Tentando enviar payload:", payloadFake);

    // Chama sua função exatamente como a API faria
    const resultado = await sendToQueue(payloadFake);

    if (resultado) {
        console.log("Sucesso! Mensagem enviada para o RabbitMQ.");
        console.log("Agora confira no painel: http://localhost:15672");
    } else {
        console.error("Falha no envio. Verifique se o Docker está rodando.");
    }

    // Encerra o processo (só para esse teste, na API real não fazemos isso)
    console.log("Aguardando confirmação de rede...");
    setTimeout(() => {
        console.log("Encerrando teste.");
        process.exit(0);
    }, 1000);
}

testarEnvio();