const express = require('express')
const http = require('http')
const socketIo = require('socket.io')
const Docker = require('dockerode')
const fs = require('fs').promises
const path = require('path')
const cors = require('cors')

const app = express()
const server = http.createServer(app)
const io = socketIo(server, {
 cors: {
   origin: "*",
   methods: ["GET", "POST"]
 }
})

const docker = new Docker()
const PORT = process.env.PORT || 8080
const SERVERS_DIR = path.join(__dirname, 'servers')
const CONFIGS_DIR = path.join(__dirname, 'configs')
const LOGS_DIR = path.join(__dirname, 'logs')

app.use(cors())
app.use(express.json())

// Garantir que diretórios existam
async function ensureDirectories() {
 await fs.mkdir(SERVERS_DIR, { recursive: true })
 await fs.mkdir(CONFIGS_DIR, { recursive: true })
 await fs.mkdir(LOGS_DIR, { recursive: true })
}

// Carregar configurações de eggs
async function loadEgg(eggId) {
 try {
   const eggPath = path.join(__dirname, 'eggs', `${eggId}.json`)
   const eggData = await fs.readFile(eggPath, 'utf-8')
   return JSON.parse(eggData)
 } catch (error) {
   console.error(`Erro ao carregar egg ${eggId}:`, error)
   throw new Error(`Egg ${eggId} não encontrado`)
 }
}

// Health check
app.get('/health', (req, res) => {
 res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Função para obter imagem Docker baseada no jogo
// Função para obter imagem Docker baseada no jogo (COM FALLBACK)
// Função simplificada para obter imagem Docker
function getDockerImage(game, egg) {
  // Para Minecraft, sempre usar Java 21
  if (game === 'minecraft') {
    return 'ghcr.io/pterodactyl/yolks:java_21'
  }
  
  if (egg.docker_images) {
    const images = Object.values(egg.docker_images)
    return images[0] || 'ghcr.io/pterodactyl/yolks:java_17'
  }
  
  const gameImages = {
    'terraria': 'ghcr.io/pterodactyl/yolks:dotnet_7',
    'rust': 'ghcr.io/pterodactyl/yolks:games',
    'valheim': 'ghcr.io/pterodactyl/yolks:steamcmd',
    'csgo': 'ghcr.io/pterodactyl/yolks:steamcmd',
    'gmod': 'ghcr.io/pterodactyl/yolks:steamcmd'
  }
  
  return gameImages[game] || 'ghcr.io/pterodactyl/yolks:java_17'
}

// Função para construir imagem customizada se necessário
// Função para construir imagem customizada se necessário (CORRIGIDA)
async function ensureMinecraftImage() {
  try {
    await docker.getImage('pyro-minecraft:latest').inspect()
    console.log(`✅ Imagem customizada pyro-minecraft:latest encontrada`)
    return true
  } catch (error) {
    console.log(`🏗️ Construindo imagem customizada pyro-minecraft:latest...`)
    
    try {
      // Verificar se os arquivos necessários existem
      const dockerfilePath = path.join(__dirname, 'minecraft.Dockerfile')
      const entrypointPath = path.join(__dirname, 'entrypoint.sh')
      
      try {
        await fs.access(dockerfilePath)
        await fs.access(entrypointPath)
        console.log(`✅ Arquivos Dockerfile e entrypoint.sh encontrados`)
      } catch (fileError) {
        console.error(`❌ Arquivos necessários não encontrados:`, fileError.message)
        return false
      }
      
      // Construir usando o contexto correto
      const stream = await docker.buildImage(__dirname, {
        t: 'pyro-minecraft:latest',
        dockerfile: 'minecraft.Dockerfile'
      })
      
      // Aguardar construção completa
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, output) => {
          if (err) {
            console.error(`❌ Erro no build:`, err)
            reject(err)
          } else {
            console.log(`✅ Imagem pyro-minecraft:latest construída com sucesso`)
            resolve(output)
          }
        }, (event) => {
          // Log do progresso do build
          if (event.stream) {
            console.log(`[BUILD] ${event.stream.trim()}`)
          }
        })
      })
      
      // Verificar se a imagem foi criada
      await docker.getImage('pyro-minecraft:latest').inspect()
      console.log(`✅ Imagem verificada com sucesso`)
      
      return true
    } catch (buildError) {
      console.error(`❌ Erro ao construir imagem customizada:`, buildError)
      return false
    }
  }
}

// Função auxiliar para notificar painel
async function notifyPanelStatus(serverId, status) {
 try {
   const panelUrl = process.env.PANEL_URL || 'http://192.168.0.117:3000'
   
   const controller = new AbortController()
   const timeoutId = setTimeout(() => controller.abort(), 10000)
   
   const response = await fetch(`${panelUrl}/api/servers/${serverId}/status`, {
     method: 'PUT',
     headers: { 
       'Content-Type': 'application/json',
       'User-Agent': 'PyroWings/1.0'
     },
     body: JSON.stringify({ status }),
     signal: controller.signal
   })
   
   clearTimeout(timeoutId)
   
   if (response.ok) {
     console.log(`📊 Status ${status} notificado ao painel para ${serverId}`)
   } else {
     console.error(`❌ Erro ao notificar painel: ${response.status}`)
   }
 } catch (error) {
   console.error(`❌ Erro ao notificar painel:`, error.message)
 }
}

// Função auxiliar para obter container do servidor
async function getServerContainer(serverId) {
 try {
   const containers = await docker.listContainers({ all: true })
   const serverContainer = containers.find(container => 
     container.Names.some(name => name.includes(`pyro-${serverId}`)) ||
     (container.Labels && container.Labels['pyro.server.id'] === serverId)
   )
   
   if (serverContainer) {
     return docker.getContainer(serverContainer.Id)
   }
   
   return null
 } catch (error) {
   console.error('Erro ao buscar container:', error)
   return null
 }
}

// Criar configuração do servidor
app.post('/api/servers/:serverId/config', async (req, res) => {
 try {
   const { serverId } = req.params
   const config = req.body
   
   console.log(`🔧 Criando configuração para servidor: ${serverId}`)
   
   const configPath = path.join(CONFIGS_DIR, `${serverId}.json`)
   await fs.writeFile(configPath, JSON.stringify(config, null, 2))
   
   const serverDir = path.join(SERVERS_DIR, serverId)
   await fs.mkdir(serverDir, { recursive: true })
   
   res.json({ success: true, message: 'Configuração criada' })
 } catch (error) {
   console.error('Erro ao criar configuração:', error)
   res.status(500).json({ error: error.message })
 }
})

// Instalar servidor
app.post('/api/servers/:serverId/install', async (req, res) => {
 try {
   const { serverId } = req.params
   
   console.log(`📦 Instalando servidor: ${serverId}`)
   
   const configPath = path.join(CONFIGS_DIR, `${serverId}.json`)
   const configData = await fs.readFile(configPath, 'utf-8')
   const config = JSON.parse(configData)
   
   const egg = await loadEgg(config.eggId)
   const serverDir = path.join(SERVERS_DIR, serverId)
   
   console.log(`🐳 Executando instalação para ${config.game}`)
   
   io.emit('server-status', { serverId, status: 'installing' })
   
   if (egg.scripts && egg.scripts.installation) {
     await runInstallationScript(serverId, egg, config, serverDir)
   } else {
     console.log(`⚠️ Nenhum script de instalação definido para ${config.eggId}`)
     io.emit('server-status', { serverId, status: 'offline' })
   }
   
   res.json({ success: true, message: 'Instalação iniciada' })
 } catch (error) {
   console.error('Erro na instalação:', error)
   io.emit('server-status', { serverId: req.params.serverId, status: 'install_failed' })
   res.status(500).json({ error: error.message })
 }
})

// Executar script de instalação
async function runInstallationScript(serverId, egg, config, serverDir) {
 console.log(`🔨 Executando script de instalação para ${serverId}`)
 
 const installScript = egg.scripts.installation.script
 const installContainer = egg.scripts.installation.container || 'ghcr.io/pterodactyl/installers:debian'
 
 const envVars = []
 if (egg.variables) {
   egg.variables.forEach(variable => {
     const value = config.variables?.[variable.env_variable] || variable.default_value
     envVars.push(`${variable.env_variable}=${value}`)
   })
 }
 
 envVars.push(`SERVER_MEMORY=${config.plan.ram * 1024}`)
 envVars.push(`SERVER_PORT=${config.port}`)
 
 try {
   try {
     await docker.getImage(installContainer).inspect()
     console.log(`✅ Imagem de instalação ${installContainer} encontrada`)
   } catch (imageError) {
     console.log(`📥 Fazendo pull da imagem de instalação ${installContainer}...`)
     const stream = await docker.pull(installContainer)
     await new Promise((resolve, reject) => {
       docker.modem.followProgress(stream, (err, output) => {
         if (err) reject(err)
         else resolve(output)
       })
     })
     console.log(`✅ Pull da imagem ${installContainer} concluído`)
   }

   const container = await docker.createContainer({
     Image: installContainer,
     Cmd: ['bash', '-c', installScript],
     Env: envVars,
     WorkingDir: '/mnt/server',
     HostConfig: {
       Binds: [`${serverDir}:/mnt/server`],
       Memory: config.plan.ram * 1024 * 1024 * 1024,
       CpuQuota: config.plan.cpu * 100000,
       AutoRemove: true
     },
     AttachStdout: true,
     AttachStderr: true
   })
   
   const stream = await container.attach({
     stream: true,
     stdout: true,
     stderr: true
   })
   
   stream.on('data', (chunk) => {
     const log = chunk.toString()
     console.log(`[INSTALL ${serverId}] ${log}`)
     io.emit('server-log', {
       serverId,
       timestamp: new Date().toISOString(),
       level: 'info',
       message: log.trim()
     })
   })
   
   await container.start()
   const result = await container.wait()
   
   if (result.StatusCode === 0) {
     console.log(`✅ Instalação concluída para ${serverId}`)
     
     const panelUrl = process.env.PANEL_URL || 'http://192.168.0.117:3000'
     console.log(`📡 Notificando painel: ${panelUrl}`)
     
     let notificationSuccess = false
     for (let attempt = 1; attempt <= 3; attempt++) {
       try {
         console.log(`📤 Tentativa ${attempt}/3 de notificar painel...`)
         
         const controller = new AbortController()
         const timeoutId = setTimeout(() => controller.abort(), 10000)
         
         const statusResponse = await fetch(`${panelUrl}/api/servers/${serverId}/status`, {
           method: 'PUT',
           headers: { 
             'Content-Type': 'application/json',
             'User-Agent': 'PyroWings/1.0'
           },
           body: JSON.stringify({ status: 'offline' }),
           signal: controller.signal
         })
         
         clearTimeout(timeoutId)
         
         if (statusResponse.ok) {
           const responseData = await statusResponse.json()
           console.log(`✅ Status atualizado no painel para ${serverId}: offline`)
           console.log(`📊 Resposta do painel:`, responseData)
           notificationSuccess = true
           break
         } else {
           const errorText = await statusResponse.text()
           console.error(`❌ Tentativa ${attempt} falhou: ${statusResponse.status} - ${errorText}`)
         }
       } catch (statusError) {
         console.error(`❌ Tentativa ${attempt} erro:`, statusError.message)
         if (attempt < 3) {
           console.log(`⏳ Aguardando 2 segundos antes da próxima tentativa...`)
           await new Promise(resolve => setTimeout(resolve, 2000))
         }
       }
     }
     
     if (!notificationSuccess) {
       console.error(`❌ FALHA: Não foi possível notificar o painel após 3 tentativas`)
     }
     
     io.emit('server-status', { serverId, status: 'offline' })
     console.log(`📡 Status emitido via WebSocket: ${serverId} -> offline`)
     
   } else {
     console.error(`❌ Instalação falhou para ${serverId} com código ${result.StatusCode}`)
     
     try {
       const panelUrl = process.env.PANEL_URL || 'http://192.168.0.117:3000'
       await fetch(`${panelUrl}/api/servers/${serverId}/status`, {
         method: 'PUT',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ status: 'install_failed' })
       })
     } catch (statusError) {
       console.error(`⚠️ Erro ao atualizar status de falha:`, statusError.message)
     }
     
     io.emit('server-status', { serverId, status: 'install_failed' })
     throw new Error(`Installation failed with exit code ${result.StatusCode}`)
   }
   
 } catch (error) {
   console.error(`❌ Erro na instalação do ${serverId}:`, error)
   
   try {
     const panelUrl = process.env.PANEL_URL || 'http://192.168.0.117:3000'
     await fetch(`${panelUrl}/api/servers/${serverId}/status`, {
       method: 'PUT',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ status: 'install_failed' })
     })
   } catch (statusError) {
     console.error(`⚠️ Erro ao notificar painel:`, statusError.message)
   }
   
   io.emit('server-status', { serverId, status: 'install_failed' })
   throw error
 }
}

// Iniciar servidor
app.post('/api/servers/:serverId/start', async (req, res) => {
 try {
   const { serverId } = req.params
   
   console.log(`🚀 Iniciando servidor: ${serverId}`)
   
   const configPath = path.join(CONFIGS_DIR, `${serverId}.json`)
   const configData = await fs.readFile(configPath, 'utf-8')
   const config = JSON.parse(configData)
   
   const egg = await loadEgg(config.eggId)
   
   const existingContainer = await getServerContainer(serverId)
   if (existingContainer) {
     const containerInfo = await existingContainer.inspect()
     if (containerInfo.State.Running) {
       return res.status(400).json({ error: 'Servidor já está rodando' })
     } else {
       await existingContainer.remove({ force: true })
     }
   }
   
   const serverDir = path.join(SERVERS_DIR, serverId)
   let dockerImage = getDockerImage(config.game, egg)
   
   console.log(`🐳 Usando imagem Docker: ${dockerImage}`)
   
   if (config.game === 'minecraft') {
  const imageReady = await ensureMinecraftImage()
  if (!imageReady) {
    console.log(`⚠️ Imagem customizada falhou, usando Java 21 padrão`)
    dockerImage = 'ghcr.io/pterodactyl/yolks:java_21'
    
    // Pull da imagem Java 21 como fallback
    try {
      await docker.getImage(dockerImage).inspect()
      console.log(`✅ Imagem fallback ${dockerImage} encontrada`)
    } catch (imageError) {
      console.log(`📥 Fazendo pull da imagem fallback ${dockerImage}...`)
      const stream = await docker.pull(dockerImage)
      await new Promise((resolve, reject) => {
        docker.modem.followProgress(stream, (err, output) => {
          if (err) reject(err)
          else resolve(output)
        })
      })
      console.log(`✅ Pull da imagem fallback ${dockerImage} concluído`)
    }
    
    // Corrigir permissões no host para Java 21
    try {
      const { spawn } = require('child_process')
      
      console.log(`🔧 Corrigindo permissões para Minecraft com Java 21...`)
      
      // Corrigir proprietário
      await new Promise((resolve) => {
        const chownProcess = spawn('chown', ['-R', '1000:1000', serverDir])
        chownProcess.on('close', (code) => {
          console.log(`📁 chown concluído com código ${code}`)
          resolve()
        })
        chownProcess.on('error', () => resolve()) // Continuar mesmo com erro
      })
      
      // Corrigir permissões
      await new Promise((resolve) => {
        const chmodProcess = spawn('chmod', ['-R', '755', serverDir])
        chmodProcess.on('close', (code) => {
          console.log(`🔧 chmod concluído com código ${code}`)
          resolve()
        })
        chmodProcess.on('error', () => resolve()) // Continuar mesmo com erro
      })
      
      console.log(`✅ Permissões corrigidas para Java 21`)
    } catch (permError) {
      console.log(`⚠️ Erro ao corrigir permissões:`, permError.message)
    }
  }
} else {
  try {
    await docker.getImage(dockerImage).inspect()
    console.log(`✅ Imagem ${dockerImage} encontrada`)
  } catch (imageError) {
    console.log(`📥 Fazendo pull da imagem ${dockerImage}...`)
    const stream = await docker.pull(dockerImage)
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err, output) => {
        if (err) reject(err)
        else resolve(output)
      })
    })
    console.log(`✅ Pull da imagem ${dockerImage} concluído`)
  }
}
   
   const envVars = []
   if (egg.variables) {
     egg.variables.forEach(variable => {
       const value = config.variables?.[variable.env_variable] || variable.default_value
       envVars.push(`${variable.env_variable}=${value}`)
     })
   }
   
   envVars.push(`SERVER_MEMORY=${config.plan.ram * 1024}`)
   envVars.push(`SERVER_PORT=${config.port}`)
   envVars.push(`PUID=1000`)
   envVars.push(`PGID=1000`)
   
   let startupCommand = egg.startup || 'echo "No startup command defined"'
   
   if (egg.variables) {
     egg.variables.forEach(variable => {
       const value = config.variables?.[variable.env_variable] || variable.default_value
       const placeholder = `{{${variable.env_variable}}}`
       startupCommand = startupCommand.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value)
     })
   }
   
   startupCommand = startupCommand.replace(/{{SERVER_MEMORY}}/g, config.plan.ram * 1024)
   startupCommand = startupCommand.replace(/{{server\.build\.default\.port}}/g, config.port)
   
   console.log(`💻 Comando de startup: ${startupCommand}`)
   console.log(`🔧 Variáveis de ambiente:`, envVars)
   
   const container = await docker.createContainer({
     Image: dockerImage,
     name: `pyro-${serverId}`,
     Cmd: ['bash', '-c', startupCommand],
     Env: envVars,
     WorkingDir: '/home/container',
     User: '0:0',
     HostConfig: {
       Binds: [`${serverDir}:/home/container:rw`],
       PortBindings: {
         [`${config.port}/tcp`]: [{ HostPort: config.port.toString() }],
         [`${config.port}/udp`]: [{ HostPort: config.port.toString() }]
       },
       Memory: config.plan.ram * 1024 * 1024 * 1024,
       CpuQuota: config.plan.cpu * 100000,
       RestartPolicy: { Name: 'unless-stopped' }
     },
     AttachStdout: true,
     AttachStderr: true,
     AttachStdin: true,
     OpenStdin: true,
     Tty: true,
     Labels: {
       'pyro.server.id': serverId,
       'pyro.server.name': config.name,
       'pyro.server.game': config.game
     }
   })
   
   const stream = await container.attach({
     stream: true,
     stdout: true,
     stderr: true,
     stdin: true
   })
   
   stream.on('data', (chunk) => {
     const log = chunk.toString()
     console.log(`[${serverId}] ${log}`)
     
     io.emit('server-log', {
       serverId,
       timestamp: new Date().toISOString(),
       level: 'info',
       message: log.trim()
     })
     
     if (egg.config && egg.config.startup && egg.config.startup.done) {
       if (log.includes(egg.config.startup.done)) {
         console.log(`✅ Servidor ${serverId} está online`)
         io.emit('server-status', { serverId, status: 'online' })
         notifyPanelStatus(serverId, 'online')
       }
     }
   })
   
   await container.start()
   
   console.log(`🎮 Servidor ${serverId} iniciado`)
   io.emit('server-status', { serverId, status: 'starting' })
   
   res.json({ success: true, message: 'Servidor iniciado' })
 } catch (error) {
   console.error('Erro ao iniciar servidor:', error)
   io.emit('server-status', { serverId: req.params.serverId, status: 'error' })
   res.status(500).json({ error: error.message })
 }
})

// Parar servidor
app.post('/api/servers/:serverId/stop', async (req, res) => {
 try {
   const { serverId } = req.params
   
   console.log(`🛑 Parando servidor: ${serverId}`)
   
   const container = await getServerContainer(serverId)
   if (!container) {
     return res.status(404).json({ error: 'Container não encontrado' })
   }
   
   const containerInfo = await container.inspect()
   if (!containerInfo.State.Running) {
     return res.status(400).json({ error: 'Servidor não está rodando' })
   }
   
   await container.stop({ t: 10 })
   await container.remove()
   
   console.log(`✅ Servidor ${serverId} parado`)
   io.emit('server-status', { serverId, status: 'offline' })
   notifyPanelStatus(serverId, 'offline')
   
   res.json({ success: true, message: 'Servidor parado' })
 } catch (error) {
   console.error('Erro ao parar servidor:', error)
   res.status(500).json({ error: error.message })
 }
})

// Reiniciar servidor
app.post('/api/servers/:serverId/restart', async (req, res) => {
 try {
   const { serverId } = req.params
   
   console.log(`🔄 Reiniciando servidor: ${serverId}`)
   
   const container = await getServerContainer(serverId)
   if (container) {
     const containerInfo = await container.inspect()
     if (containerInfo.State.Running) {
       await container.stop({ t: 10 })
       await container.remove()
     }
   }
   
   await new Promise(resolve => setTimeout(resolve, 2000))
   
   const startResponse = await fetch(`http://localhost:${PORT}/api/servers/${serverId}/start`, {
     method: 'POST'
   })
   
   if (startResponse.ok) {
     res.json({ success: true, message: 'Servidor reiniciado' })
   } else {
     throw new Error('Falha ao reiniciar servidor')
   }
 } catch (error) {
   console.error('Erro ao reiniciar servidor:', error)
   res.status(500).json({ error: error.message })
 }
})

// Forçar parada (kill)
app.post('/api/servers/:serverId/kill', async (req, res) => {
 try {
   const { serverId } = req.params
   
   console.log(`💀 Forçando parada do servidor: ${serverId}`)
   
   const container = await getServerContainer(serverId)
   if (!container) {
     return res.status(404).json({ error: 'Container não encontrado' })
   }
   
   await container.kill()
   await container.remove()
   
   console.log(`☠️ Servidor ${serverId} forçado a parar`)
   io.emit('server-status', { serverId, status: 'offline' })
   notifyPanelStatus(serverId, 'offline')
   
   res.json({ success: true, message: 'Servidor forçado a parar' })
 } catch (error) {
   console.error('Erro ao forçar parada:', error)
   res.status(500).json({ error: error.message })
 }
})

// Obter estatísticas do servidor
app.get('/api/servers/:serverId/stats', async (req, res) => {
 try {
   const { serverId } = req.params
   
   const container = await getServerContainer(serverId)
   if (!container) {
     return res.status(404).json({ error: 'Container não encontrado' })
   }
   
   const containerInfo = await container.inspect()
   if (!containerInfo.State.Running) {
     return res.json({
       cpu: 0,
       memory: { used: 0, total: 0, percent: 0 },
       network: { rx: 0, tx: 0 }
     })
   }
   
   const stats = await container.stats({ stream: false })
   
   const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage
   const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage
   const cpuPercent = (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100
   
   const memoryUsage = stats.memory_stats.usage || 0
   const memoryLimit = stats.memory_stats.limit || 0
   const memoryPercent = memoryLimit ? (memoryUsage / memoryLimit) * 100 : 0
   
   const networkRx = stats.networks?.eth0?.rx_bytes || 0
   const networkTx = stats.networks?.eth0?.tx_bytes || 0
   
   const result = {
     cpu: Math.round(cpuPercent * 100) / 100,
     memory: {
       used: Math.round(memoryUsage / 1024 / 1024),
       total: Math.round(memoryLimit / 1024 / 1024),
       percent: Math.round(memoryPercent * 100) / 100
     },
     network: {
       rx: networkRx,
       tx: networkTx
     }
   }
   
   res.json(result)
 } catch (error) {
   console.error('Erro ao obter estatísticas:', error)
   res.status(500).json({ error: error.message })
 }
})

// Obter logs do servidor
app.get('/api/servers/:serverId/logs', async (req, res) => {
 try {
   const { serverId } = req.params
   const lines = parseInt(req.query.lines) || 100
   
   const container = await getServerContainer(serverId)
   if (!container) {
     return res.status(404).json({ error: 'Container não encontrado' })
   }
   
   const logs = await container.logs({
     stdout: true,
     stderr: true,
     tail: lines,
     timestamps: true
   })
   
   const logLines = logs.toString().split('\n')
     .filter(line => line.trim())
     .map(line => {
       const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)/)
       const timestamp = timestampMatch ? timestampMatch[1] : new Date().toISOString()
       const message = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/, '')
       
       return {
         timestamp,
         level: message.includes('ERROR') ? 'error' : 
                message.includes('WARN') ? 'warning' : 'info',
         message: message.trim()
       }
     })
   
   res.json(logLines)
 } catch (error) {
   console.error('Erro ao obter logs:', error)
   res.status(500).json({ error: error.message })
 }
})

// Enviar comando para servidor
app.post('/api/servers/:serverId/command', async (req, res) => {
 try {
   const { serverId } = req.params
   const { command } = req.body
   
   if (!command) {
     return res.status(400).json({ error: 'Comando é obrigatório' })
   }
   
   console.log(`💻 Enviando comando para ${serverId}: ${command}`)
   
   const container = await getServerContainer(serverId)
   if (!container) {
     return res.status(404).json({ error: 'Container não encontrado' })
   }
   
   const containerInfo = await container.inspect()
   if (!containerInfo.State.Running) {
     return res.status(400).json({ error: 'Servidor não está rodando' })
   }
   
   const exec = await container.exec({
     Cmd: ['bash', '-c', `echo "${command}" > /proc/1/fd/0`],
     AttachStdout: true,
     AttachStderr: true
   })
   
   await exec.start()
   
   io.emit('command-output', {
     serverId,
     command,
     output: `Command sent: ${command}`,
     timestamp: new Date().toISOString()
   })
   
   res.json({ success: true, message: 'Comando enviado' })
 } catch (error) {
   console.error('Erro ao enviar comando:', error)
   res.status(500).json({ error: error.message })
 }
})

// WebSocket para logs em tempo real
io.on('connection', (socket) => {
 console.log('🔌 Cliente conectado ao WebSocket')
 
 socket.on('join-server', (serverId) => {
   socket.join(serverId)
   console.log(`📝 Cliente entrou no servidor: ${serverId}`)
 })
 
 socket.on('leave-server', (serverId) => {
   socket.leave(serverId)
   console.log(`📤 Cliente saiu do servidor: ${serverId}`)
 })
 
 socket.on('send-command', async (data) => {
   const { serverId, command } = data
   
   try {
     const container = await getServerContainer(serverId)
     if (container) {
       const exec = await container.exec({
         Cmd: ['bash', '-c', `echo "${command}" > /proc/1/fd/0`],
         AttachStdout: true,
         AttachStderr: true
       })
       
       await exec.start()
       
       io.to(serverId).emit('command-output', {
         command,
         output: `Command sent: ${command}`,
         timestamp: new Date().toISOString()
       })
     }
   } catch (error) {
     console.error('Erro ao enviar comando via WebSocket:', error)
     io.to(serverId).emit('command-output', {
       command,
       output: `Error: ${error.message}`,
       error: true,
       timestamp: new Date().toISOString()
     })
   }
 })
 
 socket.on('disconnect', () => {
   console.log('🔌 Cliente desconectado')
 })
})

// Monitorar containers
async function monitorContainers() {
 try {
   const containers = await docker.listContainers()
   
   for (const containerInfo of containers) {
     if (containerInfo.Labels && containerInfo.Labels['pyro.server.id']) {
       const serverId = containerInfo.Labels['pyro.server.id']
       const container = docker.getContainer(containerInfo.Id)
       
       try {
         const stats = await container.stats({ stream: false })
         
         const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage
         const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage
         const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * stats.cpu_stats.online_cpus * 100 : 0
         
         const memoryUsage = stats.memory_stats.usage || 0
         const memoryLimit = stats.memory_stats.limit || 0
         const memoryPercent = memoryLimit ? (memoryUsage / memoryLimit) * 100 : 0
         
         const networkRx = stats.networks?.eth0?.rx_bytes || 0
         const networkTx = stats.networks?.eth0?.tx_bytes || 0
         
         io.to(serverId).emit('server-stats', {
           cpu: Math.round(cpuPercent * 100) / 100,
           memory: {
             used: Math.round(memoryUsage / 1024 / 1024),
             total: Math.round(memoryLimit / 1024 / 1024),
             percent: Math.round(memoryPercent * 100) / 100
           },
           network: {
             rx: networkRx,
             tx: networkTx
           }
         })
       } catch (statsError) {
         console.error(`Erro ao obter stats do container ${serverId}:`, statsError)
       }
     }
   }
 } catch (error) {
   console.error('Erro ao monitorar containers:', error)
 }
}

// Verificar conectividade com painel
async function checkPanelConnectivity() {
 try {
   const panelUrl = process.env.PANEL_URL || 'http://localhost:3000'
   console.log(`🔍 Testando conectividade com painel: ${panelUrl}`)
   
   const controller = new AbortController()
   const timeoutId = setTimeout(() => controller.abort(), 5000)
   
   const response = await fetch(`${panelUrl}/api/nodes/health?nodeId=local`, {
     method: 'GET',
     signal: controller.signal
   })
   
   clearTimeout(timeoutId)
   
   if (response.ok) {
     console.log(`✅ Conectividade com painel OK`)
     return true
   } else {
     console.error(`❌ Painel respondeu com status: ${response.status}`)
     return false
   }
 } catch (error) {
   console.error(`❌ Erro ao conectar com painel:`, error.message)
   return false
 }
}

// Inicializar servidor
async function startWings() {
 try {
   await ensureDirectories()
   
   console.log('🔥 Pyro Wings Daemon iniciando...')
   console.log(`📡 Porta: ${PORT}`)
   console.log(`📁 Diretório de servidores: ${SERVERS_DIR}`)
   
   // Verificar Docker
   try {
     await docker.ping()
     console.log('🐳 Docker conectado com sucesso')
   } catch (dockerError) {
     console.error('❌ Erro ao conectar com Docker:', dockerError)
     process.exit(1)
   }
   
   // Verificar conectividade com painel
   await checkPanelConnectivity()
   
   // Iniciar monitoramento de containers
   setInterval(monitorContainers, 5000)
   
   server.listen(PORT, () => {
     console.log(`🚀 Wings Daemon rodando na porta ${PORT}`)
     console.log(`🌐 Health check: http://localhost:${PORT}/health`)
   })
   
 } catch (error) {
   console.error('❌ Erro ao iniciar Wings:', error)
   process.exit(1)
 }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
 console.log('🛑 Recebido SIGTERM, parando Wings...')
 server.close(() => {
   console.log('✅ Wings parado')
   process.exit(0)
 })
})

process.on('SIGINT', async () => {
 console.log('🛑 Recebido SIGINT, parando Wings...')
 server.close(() => {
   console.log('✅ Wings parado')
   process.exit(0)
 })
})

// Iniciar
startWings()