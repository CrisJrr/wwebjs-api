const fs = require('fs')
const path = require('path')
const { sessionFolderPath } = require('./config')
const { logger } = require('./logger')

const WEBHOOKS_FILE = path.join(sessionFolderPath, 'webhooks.json')

/**
 * Ensures the webhooks file exists, creates it with {} if it doesn't.
 */
const ensureFileExists = async () => {
    try {
        if (!fs.existsSync(sessionFolderPath)) {
            await fs.promises.mkdir(sessionFolderPath, { recursive: true })
        }
        if (!fs.existsSync(WEBHOOKS_FILE)) {
            await fs.promises.writeFile(WEBHOOKS_FILE, JSON.stringify({}, null, 2))
        }
    } catch (err) {
        logger.error({ err }, 'Error ensuring webhooks file exists')
    }
}

/**
 * Gets all dynamic webhooks mapped by sessionId.
 */
const getAllWebhooks = async () => {
    await ensureFileExists()
    try {
        const data = await fs.promises.readFile(WEBHOOKS_FILE, 'utf-8')
        return JSON.parse(data || '{}')
    } catch (err) {
        logger.error({ err }, 'Error reading webhooks file')
        return {}
    }
}

/**
 * Gets a dynamically configured webhook for a specific session.
 */
const getWebhookForSession = async (sessionId) => {
    const webhooks = await getAllWebhooks()
    return webhooks[sessionId] || null
}

/**
 * Sets or removes a dynamically configured webhook for a specific session.
 */
const setWebhookForSession = async (sessionId, webhookUrl) => {
    const webhooks = await getAllWebhooks()
    
    if (webhookUrl) {
        webhooks[sessionId] = webhookUrl
    } else {
        delete webhooks[sessionId]
    }
    
    try {
        await fs.promises.writeFile(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2))
    } catch (err) {
        logger.error({ err }, 'Error writing webhooks file')
        throw new Error('Could not save webhook configuration')
    }
}

module.exports = {
    getAllWebhooks,
    getWebhookForSession,
    setWebhookForSession
}
