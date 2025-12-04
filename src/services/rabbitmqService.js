const amqp = require("amqplib");
require("dotenv").config();

let channel = null;

// Conecta e mantém o canal aberto
async function startRabbitMQ() {
    try {
        const connection = await amqp.connect(process.env.RABBITMQ_URL);
        channel = await connection.createChannel();
        
        // Garante que a fila existe
        await channel.assertQueue("tarefas_importantes", { durable: true });
        console.log("✅ RabbitMQ Conectado e Fila pronta!");
        
        // Tratamento de erro se a conexão cair
        connection.on("error", (err) => {
            console.error("Erro na conexão RabbitMQ:", err);
            setTimeout(startRabbitMQ, 5000); // Tenta reconectar
        });
    } catch (error) {
        console.error("Falha ao conectar no RabbitMQ:", error);
        setTimeout(startRabbitMQ, 5000);
    }
}

// Função pública para enviar mensagens
async function sendToQueue(data) {
    if (!channel) {
        console.error("RabbitMQ não iniciado. Tentando reconectar...");
        await startRabbitMQ();
    }
    try {
        // Converte o objeto JSON em Buffer
        const buffer = Buffer.from(JSON.stringify(data));
        channel.sendToQueue("tarefas_importantes", buffer, { persistent: true });
        return true;
    } catch (error) {
        console.error("Erro ao enviar para fila:", error);
        return false;
    }
}

module.exports = { startRabbitMQ, sendToQueue };