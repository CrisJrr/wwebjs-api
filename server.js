// Load environment variables first
require('dotenv').config({ path: process.env.ENV_PATH || '.env' })

const app = require('./src/app')
const { baseWebhookURL, enableWebHook, enableWebSocket, autoStartSessions } = require('./src/config')
const { logger } = require('./src/logger')
const { handleUpgrade } = require('./src/websocket')
const { restoreSessions } = require('./src/sessions')
const { startRabbitMQ } = require('./src/services/rabbitmqService') // <--- ADICIONE ISSO

// Start the server
const port = process.env.PORT || 3000

// Check if BASE_WEBHOOK_URL environment variable is available when WebHook is enabled
if (!baseWebhookURL && enableWebHook) {
  logger.error('BASE_WEBHOOK_URL environment variable is not set. Exiting...')
  process.exit(1) // Terminate the application with an error code
}

const server = app.listen(port, async () => { // <--- Note o "async" aqui se quiser usar await, mas não é estritamente necessário se a função tratar erros internamente
  logger.info(`Server running on port ${port}`)
  logger.debug({ configuration: require('./src/config') }, 'Service configuration')
  
  // <--- ADICIONE O BLOCO ABAIXO
  logger.info('Iniciando conexão com RabbitMQ...')
  await startRabbitMQ(); 
  // <--- FIM DO BLOCO

  if (autoStartSessions) {
    logger.info('Starting all sessions')
    restoreSessions()
  }
})

if (enableWebSocket) {
  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head)
  })
}

// puppeteer uses subscriptions to SIGINT, SIGTERM, and SIGHUP to know when to close browser instances
// this disables the warnings when you starts more than 10 browser instances
process.setMaxListeners(0)