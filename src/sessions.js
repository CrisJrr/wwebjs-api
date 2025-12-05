const { Client, LocalAuth } = require('whatsapp-web.js')
const fs = require('fs')
const path = require('path')
const sessions = new Map()
const { disableGlobalWebhooks, baseWebhookURL, callbackURLList, sessionFolderPath, maxAttachmentSize, setMessagesAsSeen, webVersion, webVersionCacheType, recoverSessions, chromeBin, headless, releaseBrowserLock } = require('./config')
const { triggerWebhook, waitForNestedObject, isEventEnabled, sendMessageSeenStatus, sleep, patchWWebLibrary } = require('./utils')
const { logger } = require('./logger')
const { initWebSocketServer, terminateWebSocketServer, triggerWebSocket } = require('./websocket')
const { sendToQueue } = require('./services/rabbitmqService')
const axios = require('axios')

// Function to validate if the session is ready
const validateSession = async (sessionId) => {
  try {
    const returnData = { success: false, state: null, message: '' }

    // Session not Connected 😢
    if (!sessions.has(sessionId) || !sessions.get(sessionId)) {
      returnData.message = 'session_not_found'
      return returnData
    }

    const client = sessions.get(sessionId)
    // wait until the client is created
    await waitForNestedObject(client, 'pupPage')
      .catch((err) => { return { success: false, state: null, message: err.message } })

    // Wait for client.pupPage to be evaluable
    let maxRetry = 0
    while (true) {
      try {
        if (client.pupPage.isClosed()) {
          return { success: false, state: null, message: 'browser tab closed' }
        }
        await Promise.race([
          client.pupPage.evaluate('1'),
          new Promise(resolve => setTimeout(resolve, 1000))
        ])
        break
      } catch (error) {
        if (maxRetry === 2) {
          return { success: false, state: null, message: 'session closed' }
        }
        maxRetry++
      }
    }

    const state = await client.getState()
    returnData.state = state
    if (state !== 'CONNECTED') {
      returnData.message = 'session_not_connected'
      return returnData
    }

    // Session Connected 🎉
    returnData.success = true
    returnData.message = 'session_connected'
    return returnData
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to validate session')
    return { success: false, state: null, message: error.message }
  }
}

// Function to handle client session restoration
const restoreSessions = () => {
  try {
    if (!fs.existsSync(sessionFolderPath)) {
      fs.mkdirSync(sessionFolderPath) // Create the session directory if it doesn't exist
    }
    // Read the contents of the folder
    fs.readdir(sessionFolderPath, async (_, files) => {
      // Iterate through the files in the parent folder
      for (const file of files) {
        // Use regular expression to extract the string from the folder name
        const match = file.match(/^session-(.+)$/)
        if (match) {
          const sessionId = match[1]
          logger.warn({ sessionId }, 'Existing session detected')
          await setupSession(sessionId)
        }
      }
    })
  } catch (error) {
    logger.error(error, 'Failed to restore sessions')
  }
}

// Setup Session
const setupSession = async (sessionId) => {
  try {
    if (sessions.has(sessionId)) {
      return { success: false, message: `Session already exists for: ${sessionId}`, client: sessions.get(sessionId) }
    }
    console.log({ sessionId }, 'Session is being initiated')
    // Disable the delete folder from the logout function (will be handled separately)
    const localAuth = new LocalAuth({ clientId: sessionId, dataPath: sessionFolderPath })
    delete localAuth.logout
    localAuth.logout = () => { }

    const clientOptions = {
      puppeteer: {
        executablePath: chromeBin,
        headless,
        args: [
          '--autoplay-policy=user-gesture-required',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-dev-shm-usage',
          '--disable-domain-reliability',
          '--disable-extensions',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-notifications',
          '--disable-offer-store-unmasked-wallet-cards',
          '--disable-popup-blocking',
          '--disable-print-preview',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--disable-speech-api',
          '--disable-sync',
          '--disable-gpu',
          '--disable-accelerated-2d-canvas',
          '--hide-scrollbars',
          '--ignore-gpu-blacklist',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-first-run',
          '--no-pings',
          '--no-zygote',
          '--password-store=basic',
          '--use-gl=swiftshader',
          '--use-mock-keychain',
          '--disable-setuid-sandbox',
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled'
        ]
      },
      authStrategy: localAuth
    }

    if (webVersion) {
      clientOptions.webVersion = webVersion
      switch (webVersionCacheType.toLowerCase()) {
        case 'local':
          clientOptions.webVersionCache = {
            type: 'local'
          }
          break
        case 'remote':
          clientOptions.webVersionCache = {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/' + webVersion + '.html'
          }
          break
        default:
          clientOptions.webVersionCache = {
            type: 'none'
          }
      }
    }

    const client = new Client(clientOptions)
    if (releaseBrowserLock) {
      // See https://github.com/puppeteer/puppeteer/issues/4860
      const singletonLockPath = path.resolve(path.join(sessionFolderPath, `session-${sessionId}`, 'SingletonLock'))
      const singletonLockExists = await fs.promises.lstat(singletonLockPath).then(() => true).catch(() => false)
      if (singletonLockExists) {
        logger.warn({ sessionId }, 'Browser lock file exists, removing')
        await fs.promises.unlink(singletonLockPath)
      }
    }

    try {
      client.once('ready', () => {
        patchWWebLibrary(client).catch((err) => {
          logger.error({ sessionId, err }, 'Failed to patch WWebJS library')
        })
      })
      initWebSocketServer(sessionId)
      initializeEvents(client, sessionId)
      await client.initialize()
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Initialize error')
      throw error
    }

    // Save the session to the Map
    sessions.set(sessionId, client)
    return { success: true, message: 'Session initiated successfully', client }
  } catch (error) {
    return { success: false, message: error.message, client: null }
  }
}

const initializeEvents = (client, sessionId) => {
  // check if the session webhook is overridden
//   const sessionWebhook = process.env[sessionId.toUpperCase() + '_WEBHOOK_URL'] || baseWebhookURL

  if (recoverSessions) {
    waitForNestedObject(client, 'pupPage').then(() => {
      const restartSession = async (sessionId) => {
        sessions.delete(sessionId)
        await client.destroy().catch(e => { })
        await setupSession(sessionId)
      }
      client.pupPage.once('close', function () {
        // emitted when the page closes
        logger.warn({ sessionId }, 'Browser page closed. Restoring')
        restartSession(sessionId)
      })
      client.pupPage.once('error', function () {
        // emitted when the page crashes
        logger.warn({ sessionId }, 'Error occurred on browser page. Restoring')
        restartSession(sessionId)
      })
      client.pupPage
        .on('console', message => {
          const type = message.type().substr(0, 3).toUpperCase()
          logger.debug({ sessionId, type }, `Page console log: ${message.text()}`)
        })
        .on('requestfailed', request => {
          const failure = request.failure()
          if (failure) {
            logger.error({ sessionId, url: request.url() }, `Page request failed: ${failure.errorText}`)
          } else {
            logger.error({ sessionId, url: request.url() }, 'Page request failed but no failure reason provided')
          }
        })
        .on('pageerror', ({ message }) => logger.error({ sessionId, message }, 'Page error occurred'))
    }).catch(e => { })
  }

  if (isEventEnabled('auth_failure')) {
    client.on('auth_failure', (msg) => {
      triggerAllWebhooks(sessionId, 'status', { msg })
      triggerWebSocket(sessionId, 'status', { msg })
    })
  }

  client.on('authenticated', () => {
    client.qr = null
    if (isEventEnabled('authenticated')) {
      triggerAllWebhooks(sessionId, 'authenticated')
      triggerWebSocket(sessionId, 'authenticated')
    }
  })

  // if (isEventEnabled('call')) {
  //   client.on('call', (call) => {
  //     triggerAllWebhooks(sessionId, 'call', { call })
  //     triggerWebSocket(sessionId, 'call', { call })
  //   })
  // }

  // if (isEventEnabled('change_state')) {
  //   client.on('change_state', state => {
  //     triggerAllWebhooks(sessionId, 'change_state', { state })
  //     triggerWebSocket(sessionId, 'change_state', { state })
  //   })
  // }

  if (isEventEnabled('disconnected')) {
    client.on('disconnected', (reason) => {
      triggerAllWebhooks(sessionId, 'disconnected', { reason })
      triggerWebSocket(sessionId, 'disconnected', { reason })
    })
  }

  // if (isEventEnabled('group_join')) {
  //   client.on('group_join', (notification) => {
  //     triggerAllWebhooks(sessionId, 'group_join', { notification })
  //     triggerWebSocket(sessionId, 'group_join', { notification })
  //   })
  // }

  // if (isEventEnabled('group_leave')) {
  //   client.on('group_leave', (notification) => {
  //     triggerAllWebhooks(sessionId, 'group_leave', { notification })
  //     triggerWebSocket(sessionId, 'group_leave', { notification })
  //   })
  // }

  // if (isEventEnabled('group_admin_changed')) {
  //   client.on('group_admin_changed', (notification) => {
  //     triggerAllWebhooks(sessionId, 'group_admin_changed', { notification })
  //     triggerWebSocket(sessionId, 'group_admin_changed', { notification })
  //   })
  // }

  // if (isEventEnabled('group_membership_request')) {
  //   client.on('group_membership_request', (notification) => {
  //     triggerAllWebhooks(sessionId, 'group_membership_request', { notification })
  //     triggerWebSocket(sessionId, 'group_membership_request', { notification })
  //   })
  // }

  // if (isEventEnabled('group_update')) {
  //   client.on('group_update', (notification) => {
  //     triggerAllWebhooks(sessionId, 'group_update', { notification })
  //     triggerWebSocket(sessionId, 'group_update', { notification })
  //   })
  // }

  // if (isEventEnabled('loading_screen')) {
  //   client.on('loading_screen', (percent, message) => {
  //     triggerAllWebhooks(sessionId, 'loading_screen', { percent, message })
  //     triggerWebSocket(sessionId, 'loading_screen', { percent, message })
  //   })
  // }

  // if (isEventEnabled('media_uploaded')) {
  //   client.on('media_uploaded', (message) => {
  //     triggerAllWebhooks(sessionId, 'media_uploaded', { message })
  //     triggerWebSocket(sessionId, 'media_uploaded', { message })
  //   })
  // }

client.on('message', async (message) => {
    if (isEventEnabled('message')) {
        
        // --- DEBUG AREA: INICIO ---
        const envKey = 'SESSION_' + sessionId.toUpperCase() + '_WEBHOOK_URL'
        const specificUrl = process.env[envKey]
        
        console.log('------------------------------------------------')
        console.log(`🕵️ [DEBUG] Sessão Atual (ID): "${sessionId}"`)
        console.log(`🔑 [DEBUG] Buscando Variável de Ambiente: "${envKey}"`)
        console.log(`🔗 [DEBUG] Valor Encontrado: ${specificUrl ? specificUrl : 'NÃO DEFINIDO'}`)
        // --------------------------

        if (specificUrl) {
            console.log('✅ [DECISÃO] Webhook Específico encontrado! -> Iniciando Teste de Conexão (AXIOS DIRECT)')
            
            // --- BYPASS DE DIAGNÓSTICO (AXIOS) ---
            try {
                console.log(`🚀 [AXIOS] Disparando POST para: ${specificUrl}`);

                // Envia com timeout curto (5 segundos) para não travar o bot se a rede estiver ruim
                const response = await axios.post(specificUrl, message, { timeout: 5000 });

                console.log('================================================');
                console.log(`🎉 [SUCESSO TOTAL] O Webhook respondeu!`);
                console.log(`   Status Code: ${response.status}`);
                console.log(`   Resposta: ${JSON.stringify(response.data)}`);
                console.log('================================================');

                // Se quiser manter o WebSocket ativo visualmente
                triggerWebSocket(sessionId, 'message', { message });

            } catch (error) {
                console.log('================================================');
                console.log(`❌ [FALHA CRÍTICA] O Axios não conseguiu entregar:`);
                console.log(`   Mensagem de Erro: ${error.message}`);
                
                if (error.response) {
                    // O servidor respondeu, mas com erro (404, 500, 403)
                    console.log(`   Status do Servidor: ${error.response.status}`);
                    console.log(`   Dados do Erro: ${JSON.stringify(error.response.data)}`);
                } else if (error.request) {
                    // A requisição saiu mas ninguém respondeu (Timeout, DNS, Firewall)
                    console.log(`   Causa provável: Timeout ou Bloqueio de Rede (O servidor não respondeu)`);
                }
                console.log('================================================');
            }
            // --- FIM DO BYPASS ---
        
        } else {
            console.log('⚠️ [DECISÃO] Nenhum Webhook Específico -> Enviando para RabbitMQ');
            
            try {
                const rabbitPayload = {
                    sessionId: sessionId,
                    event: 'message',
                    from: message.from,
                    to: message.to,
                    body: message.body,
                    hasMedia: message.hasMedia,
                    timestamp: message.timestamp,
                    deviceType: message.deviceType,
                    isGroup: message.from.includes('@g.us')
                };

                await sendToQueue(rabbitPayload);
            } catch (err) {
                logger.error({ sessionId, err }, 'Falha ao enviar mensagem para RabbitMQ');
            }
        }
        
        // Mantém a lógica de visto por último
        if (setMessagesAsSeen) {
            await sleep(1000)
            sendMessageSeenStatus(message)
        }
    }
})

  // if (isEventEnabled('message_ack')) {
  //   client.on('message_ack', (message, ack) => {
  //     triggerAllWebhooks(sessionId, 'message_ack', { message, ack })
  //     triggerWebSocket(sessionId, 'message_ack', { message, ack })
  //   })
  // }

  // if (isEventEnabled('message_create')) {
  //   client.on('message_create', (message) => {
  //     triggerAllWebhooks(sessionId, 'message_create', { message })
  //     triggerWebSocket(sessionId, 'message_create', { message })
  //   })
  // }

  // if (isEventEnabled('message_reaction')) {
  //   client.on('message_reaction', (reaction) => {
  //     triggerAllWebhooks(sessionId, 'message_reaction', { reaction })
  //     triggerWebSocket(sessionId, 'message_reaction', { reaction })
  //   })
  // }

  // if (isEventEnabled('message_edit')) {
  //   client.on('message_edit', (message, newBody, prevBody) => {
  //     triggerAllWebhooks(sessionId, 'message_edit', { message, newBody, prevBody })
  //     triggerWebSocket(sessionId, 'message_edit', { message, newBody, prevBody })
  //   })
  // }

  // if (isEventEnabled('message_ciphertext')) {
  //   client.on('message_ciphertext', (message) => {
  //     triggerAllWebhooks(sessionId, 'message_ciphertext', { message })
  //     triggerWebSocket(sessionId, 'message_ciphertext', { message })
  //   })
  // }

  // if (isEventEnabled('message_revoke_everyone')) {
  //   client.on('message_revoke_everyone', (message) => {
  //     triggerAllWebhooks(sessionId, 'message_revoke_everyone', { message })
  //     triggerWebSocket(sessionId, 'message_revoke_everyone', { message })
  //   })
  // }

  // if (isEventEnabled('message_revoke_me')) {
  //   client.on('message_revoke_me', (message, revokedMsg) => {
  //     triggerAllWebhooks(sessionId, 'message_revoke_me', { message, revokedMsg })
  //     triggerWebSocket(sessionId, 'message_revoke_me', { message, revokedMsg })
  //   })
  // }

  client.on('qr', (qr) => {
    // inject qr code into session
    client.qr = qr
    if (isEventEnabled('qr')) {
      triggerAllWebhooks(sessionId, 'qr', { qr })
      triggerWebSocket(sessionId, 'qr', { qr })
    }
  })

  if (isEventEnabled('ready')) {
    client.on('ready', () => {
      triggerAllWebhooks(sessionId, 'ready')
      triggerWebSocket(sessionId, 'ready')
    })
  }

  // if (isEventEnabled('contact_changed')) {
  //   client.on('contact_changed', (message, oldId, newId, isContact) => {
  //     triggerAllWebhooks(sessionId, 'contact_changed', { message, oldId, newId, isContact })
  //     triggerWebSocket(sessionId, 'contact_changed', { message, oldId, newId, isContact })
  //   })
  // }

  // if (isEventEnabled('chat_removed')) {
  //   client.on('chat_removed', (chat) => {
  //     triggerAllWebhooks(sessionId, 'chat_removed', { chat })
  //     triggerWebSocket(sessionId, 'chat_removed', { chat })
  //   })
  // }

  // if (isEventEnabled('chat_archived')) {
  //   client.on('chat_archived', (chat, currState, prevState) => {
  //     triggerAllWebhooks(sessionId, 'chat_archived', { chat, currState, prevState })
  //     triggerWebSocket(sessionId, 'chat_archived', { chat, currState, prevState })
  //   })
  // }

  // if (isEventEnabled('unread_count')) {
  //   client.on('unread_count', (chat) => {
  //     triggerAllWebhooks(sessionId, 'unread_count', { chat })
  //     triggerWebSocket(sessionId, 'unread_count', { chat })
  //   })
  // }

  // if (isEventEnabled('vote_update')) {
  //   client.on('vote_update', (vote) => {
  //     triggerAllWebhooks(sessionId, 'vote_update', { vote })
  //     triggerWebSocket(sessionId, 'vote_update', { vote })
  //   })
  // }

//   if (isEventEnabled('code')) {
//     client.on('code', (code) => {
//       triggerAllWebhooks(sessionId, 'code', { code })
//       triggerWebSocket(sessionId, 'code', { code })
//     })
//   }
}

// Function to delete client session folder
const deleteSessionFolder = async (sessionId) => {
  try {
    const targetDirPath = path.join(sessionFolderPath, `session-${sessionId}`)
    const resolvedTargetDirPath = await fs.promises.realpath(targetDirPath)
    const resolvedSessionPath = await fs.promises.realpath(sessionFolderPath)

    // Ensure the target directory path ends with a path separator
    const safeSessionPath = `${resolvedSessionPath}${path.sep}`

    // Validate the resolved target directory path is a subdirectory of the session folder path
    if (!resolvedTargetDirPath.startsWith(safeSessionPath)) {
      throw new Error('Invalid path: Directory traversal detected')
    }
    await fs.promises.rm(resolvedTargetDirPath, { recursive: true, force: true })
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Folder deletion error')
    throw error
  }
}

// Function to reload client session without removing browser cache
const reloadSession = async (sessionId) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      const pages = await client.pupBrowser.pages()
      await Promise.all(pages.map((page) => page.close()))
      await Promise.race([
        client.pupBrowser.close(),
        new Promise(resolve => setTimeout(resolve, 5000))
      ])
    } catch (e) {
      const childProcess = client.pupBrowser.process()
      if (childProcess) {
        childProcess.kill(9)
      }
    }
    sessions.delete(sessionId)
    await setupSession(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to reload session')
    throw error
  }
}

const destroySession = async (sessionId) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      await terminateWebSocketServer(sessionId)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
    }
    await client.destroy()
    // Wait 10 secs for client.pupBrowser to be disconnected
    let maxDelay = 0
    while (client.pupBrowser?.isConnected() && (maxDelay < 10)) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      maxDelay++
    }
    sessions.delete(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to stop session')
    throw error
  }
}

const deleteSession = async (sessionId, validation) => {
  try {
    const client = sessions.get(sessionId)
    if (!client) {
      return
    }
    client.pupPage?.removeAllListeners('close')
    client.pupPage?.removeAllListeners('error')
    try {
      await terminateWebSocketServer(sessionId)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to terminate WebSocket server')
    }
    if (validation.success) {
      // Client Connected, request logout
      console.log({ sessionId }, 'Logging out session')
      await client.logout()
    } else if (validation.message === 'session_not_connected') {
      // Client not Connected, request destroy
      console.log({ sessionId }, 'Destroying session')
      await client.destroy()
    }
    // Wait 10 secs for client.pupBrowser to be disconnected before deleting the folder
    let maxDelay = 0
    while (client.pupBrowser.isConnected() && (maxDelay < 10)) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      maxDelay++
    }
    sessions.delete(sessionId)
    await deleteSessionFolder(sessionId)
  } catch (error) {
    logger.error({ sessionId, err: error }, 'Failed to delete session')
    throw error
  }
}

// Function to handle session flush
const flushSessions = async (deleteOnlyInactive) => {
  try {
    // Read the contents of the sessions folder
    const files = await fs.promises.readdir(sessionFolderPath)
    // Iterate through the files in the parent folder
    for (const file of files) {
      // Use regular expression to extract the string from the folder name
      const match = file.match(/^session-(.+)$/)
      if (match) {
        const sessionId = match[1]
        const validation = await validateSession(sessionId)
        if (!deleteOnlyInactive || !validation.success) {
          await deleteSession(sessionId, validation)
        }
      }
    }
  } catch (error) {
    logger.error(error, 'Failed to flush sessions')
    throw error
  }
}

const triggerAllWebhooks = (sessionId, event, payload = {}) => {
    // --- DEBUG LOGS ---
    // console.log(`[DEBUG] triggerAllWebhooks chamado para Sessão: ${sessionId}, Evento: ${event}`);

    const envKey = 'SESSION_' + sessionId.toUpperCase() + '_WEBHOOK_URL';
    const sessionSpecificUrl = process.env[envKey];
    
    // Verifica se callbackURLList existe para evitar crash
    if (!callbackURLList) {
        logger.error(`[CRITICO] callbackURLList é undefined!`);
        return;
    }

    const targets = new Set();
    
    // 1. Sempre tenta adicionar a URL Específica da sessão
    if (sessionSpecificUrl) {
        targets.add(sessionSpecificUrl);
    }

    // 2. Só adiciona os Globais se a configuração permitir
    // Se DISABLE_GLOBAL_WEBHOOKS for true, ele PULA este bloco
    if (!disableGlobalWebhooks) {
        callbackURLList.forEach(url => targets.add(url));
    }
    
    // Se não tiver nenhuma URL (nem específica, nem global habilitada), sai.
    if (targets.size === 0) {
        // logger.debug({ sessionId, event }, 'Nenhum Webhook URL definido/habilitado para este evento.');
        return;
    }
    
    const promises = Array.from(targets).map(url => {
        return triggerWebhook(url, sessionId, event, payload);
    });

    Promise.allSettled(promises).then(results => {
        results.forEach((result, index) => {
            const targetUrl = Array.from(targets)[index];
            if (result.status === 'rejected') {
                logger.error({ sessionId, url: targetUrl, event, err: result.reason }, '❌ Falha ao disparar Webhook');
            }
        });
    }).catch(e => {
        logger.error({ sessionId, event, err: e }, 'Erro fatal no Promise.all');
    });
};

module.exports = {
  sessions,
  setupSession,
  restoreSessions,
  validateSession,
  deleteSession,
  reloadSession,
  flushSessions,
  triggerAllWebhooks,
  destroySession
}
