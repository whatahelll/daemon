// daemon/wings.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');
const cron = require('node-cron');

class WingsDaemon {
  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.io = socketIo(this.server, {
      cors: {
        origin: process.env.PANEL_URL || ["http://localhost:3000", "https://localhost:3000"],
        methods: ["GET", "POST"],
        allowedHeaders: ["*"],
        credentials: true
      }
    });
    
    this.docker = new Docker();
    this.containers = new Map(); // serverId -> container
    this.serverStats = new Map(); // serverId -> stats
    this.serverConfigs = new Map(); // serverId -> config
    this.eggs = new Map(); // eggId -> egg config
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.startStatsMonitoring();
    this.setupCleanupTasks();
    this.loadEggs();
    
    console.log('🔥 Wings Daemon inicializando...');
  }

  setupMiddleware() {
    this.app.use(cors({
      origin: process.env.PANEL_URL || ["http://localhost:3000", "https://localhost:3000"],
      credentials: true
    }));
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
  }

  setupRoutes() {
    // Eggs management
    this.app.get('/api/eggs', this.getEggs.bind(this));
    this.app.get('/api/eggs/:id', this.getEgg.bind(this));
    this.app.post('/api/eggs', this.createEgg.bind(this));
    this.app.put('/api/eggs/:id', this.updateEgg.bind(this));
    this.app.delete('/api/eggs/:id', this.deleteEgg.bind(this));
    
    // Server configuration
    this.app.post('/api/servers/:id/config', this.createServerConfig.bind(this));
    this.app.get('/api/servers/:id/config', this.getServerConfig.bind(this));
    this.app.put('/api/servers/:id/config', this.updateServerConfig.bind(this));
    
    // Server control
    this.app.post('/api/servers/:id/start', this.startServer.bind(this));
    this.app.post('/api/servers/:id/stop', this.stopServer.bind(this));
    this.app.post('/api/servers/:id/restart', this.restartServer.bind(this));
    this.app.post('/api/servers/:id/kill', this.killServer.bind(this));
    this.app.post('/api/servers/:id/install', this.installServer.bind(this));
    this.app.post('/api/servers/:id/reinstall', this.reinstallServer.bind(this));
    
    // Commands and console
    this.app.post('/api/servers/:id/command', this.sendCommand.bind(this));
    
    // Stats and logs
    this.app.get('/api/servers/:id/stats', this.getServerStats.bind(this));
    this.app.get('/api/servers/:id/logs', this.getServerLogs.bind(this));
    
    // File management
    this.app.get('/api/servers/:id/files', this.getServerFiles.bind(this));
    this.app.post('/api/servers/:id/files', this.uploadFile.bind(this));
    this.app.put('/api/servers/:id/files', this.updateFile.bind(this));
    this.app.delete('/api/servers/:id/files', this.deleteFile.bind(this));
    this.app.post('/api/servers/:id/files/compress', this.compressFiles.bind(this));
    this.app.post('/api/servers/:id/files/extract', this.extractFiles.bind(this));
    this.app.post('/api/servers/:id/files/copy', this.copyFile.bind(this));
    this.app.post('/api/servers/:id/files/rename', this.renameFile.bind(this));
    
    console.log('✅ Rotas configuradas');
  }

  setupWebSocket() {
    this.io.on('connection', (socket) => {
      console.log(`🔌 Cliente conectado: ${socket.id}`);

      socket.on('join-server', (serverId) => {
        socket.join(serverId);
        console.log(`📝 Cliente ${socket.id} entrou no servidor ${serverId}`);
        
        const container = this.containers.get(serverId);
        if (container) {
          socket.emit('server-status', { status: 'online' });
        } else {
          socket.emit('server-status', { status: 'offline' });
        }
      });

      socket.on('leave-server', (serverId) => {
        socket.leave(serverId);
        console.log(`📤 Cliente ${socket.id} saiu do servidor ${serverId}`);
      });

      socket.on('send-command', async (data) => {
        const { serverId, command } = data;
        console.log(`💻 Comando recebido para ${serverId}: ${command}`);
        await this.executeCommand(serverId, command, socket);
      });

      socket.on('disconnect', () => {
        console.log(`❌ Cliente desconectado: ${socket.id}`);
      });
    });
    
    console.log('✅ WebSocket configurado');
  }

  async loadEggs() {
    try {
      const eggsDir = path.join(__dirname, 'eggs');
      await fs.mkdir(eggsDir, { recursive: true });
      
      const eggFiles = await fs.readdir(eggsDir);
      
      for (const eggFile of eggFiles) {
        if (eggFile.endsWith('.json')) {
          try {
            const eggPath = path.join(eggsDir, eggFile);
            const eggData = await fs.readFile(eggPath, 'utf8');
            const egg = JSON.parse(eggData);
            this.eggs.set(egg.uuid, egg);
            console.log(`🥚 Egg carregado: ${egg.name}`);
          } catch (error) {
            console.error(`❌ Erro ao carregar egg ${eggFile}:`, error);
          }
        }
      }
      
      // Se não há eggs, criar alguns padrão
      if (this.eggs.size === 0) {
        await this.createDefaultEggs();
      }
      
      console.log(`✅ ${this.eggs.size} eggs carregados`);
    } catch (error) {
      console.error('❌ Erro ao carregar eggs:', error);
    }
  }

  async createDefaultEggs() {
    const defaultEggs = [
      {
        uuid: 'minecraft-vanilla',
        name: 'Minecraft Vanilla',
        description: 'Vanilla Minecraft server',
        docker_image: 'itzg/minecraft-server:latest',
        config: {
          startup: 'java -Xms{{SERVER_MEMORY}}M -Xmx{{SERVER_MEMORY}}M -jar server.jar nogui',
          stop: 'stop',
          logs: {
            custom: false,
            location: 'logs/latest.log'
          },
          files: {
            'server.properties': {
              parser: 'properties',
              find: {
                'server-port': '{{SERVER_PORT}}',
                'max-players': '{{MAX_PLAYERS}}',
                'server-name': '{{SERVER_NAME}}',
                'motd': '{{MOTD}}'
              }
            },
            'eula.txt': {
              parser: 'file',
              find: 'eula=true'
            }
          }
        },
        variables: [
          {
            name: 'SERVER_MEMORY',
            description: 'Server Memory in MB',
            env_variable: 'SERVER_MEMORY',
            default_value: '1024',
            user_viewable: true,
            user_editable: true,
            rules: 'required|numeric|min:512'
          },
          {
            name: 'SERVER_PORT',
            description: 'Server Port',
            env_variable: 'SERVER_PORT',
            default_value: '25565',
            user_viewable: true,
            user_editable: false,
            rules: 'required|numeric|between:1024,65535'
          },
          {
            name: 'MAX_PLAYERS',
            description: 'Maximum Players',
            env_variable: 'MAX_PLAYERS',
            default_value: '20',
            user_viewable: true,
            user_editable: true,
            rules: 'required|numeric|min:1'
          },
          {
            name: 'SERVER_NAME',
            description: 'Server Name',
            env_variable: 'SERVER_NAME',
            default_value: 'A Minecraft Server',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string|max:255'
          },
          {
            name: 'MOTD',
            description: 'Message of the Day',
            env_variable: 'MOTD',
            default_value: 'Welcome to the server!',
            user_viewable: true,
            user_editable: true,
            rules: 'string|max:255'
          },
          {
            name: 'VERSION',
            description: 'Minecraft Version',
            env_variable: 'VERSION',
            default_value: 'LATEST',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string'
          }
        ]
      },
      {
        uuid: 'terraria',
        name: 'Terraria',
        description: 'Terraria dedicated server',
        docker_image: 'ryshe/terraria:latest',
        config: {
          startup: './TerrariaServer.bin.x86_64 -config serverconfig.txt',
          stop: 'exit',
          logs: {
            custom: false,
            location: 'logs'
          }
        },
        variables: [
          {
            name: 'WORLD_NAME',
            description: 'World Name',
            env_variable: 'WORLD_NAME',
            default_value: 'World',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string|max:255'
          },
          {
            name: 'MAX_PLAYERS',
            description: 'Maximum Players',
            env_variable: 'MAX_PLAYERS',
            default_value: '8',
            user_viewable: true,
            user_editable: true,
            rules: 'required|numeric|min:1|max:255'
          },
          {
            name: 'SERVER_PORT',
            description: 'Server Port',
            env_variable: 'SERVER_PORT',
            default_value: '7777',
            user_viewable: true,
            user_editable: false,
            rules: 'required|numeric|between:1024,65535'
          }
        ]
      },
      {
        uuid: 'rust',
        name: 'Rust',
        description: 'Rust dedicated server',
        docker_image: 'didstopia/rust-server:latest',
        config: {
          startup: './RustDedicated -batchmode +server.hostname "{{HOSTNAME}}" +server.port {{SERVER_PORT}} +server.maxplayers {{MAX_PLAYERS}} +server.identity "{{IDENTITY}}" +server.seed {{SEED}} +server.worldsize {{WORLD_SIZE}} +server.saveinterval {{SAVE_INTERVAL}} +rcon.web 1 +rcon.ip 0.0.0.0 +rcon.port {{RCON_PORT}} +rcon.password "{{RCON_PASSWORD}}"',
          stop: 'quit',
          logs: {
            custom: false,
            location: 'logs'
          }
        },
        variables: [
          {
            name: 'HOSTNAME',
            description: 'Server Hostname',
            env_variable: 'HOSTNAME',
            default_value: 'A Rust Server',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string|max:255'
          },
          {
            name: 'SERVER_PORT',
            description: 'Server Port',
            env_variable: 'SERVER_PORT',
            default_value: '28015',
            user_viewable: true,
            user_editable: false,
            rules: 'required|numeric|between:1024,65535'
          },
          {
            name: 'MAX_PLAYERS',
            description: 'Maximum Players',
            env_variable: 'MAX_PLAYERS',
            default_value: '100',
            user_viewable: true,
            user_editable: true,
            rules: 'required|numeric|min:1|max:300'
          },
          {
            name: 'SEED',
            description: 'World Seed',
            env_variable: 'SEED',
            default_value: '12345',
            user_viewable: true,
            user_editable: true,
            rules: 'numeric'
          },
          {
            name: 'WORLD_SIZE',
            description: 'World Size',
            env_variable: 'WORLD_SIZE',
            default_value: '3000',
            user_viewable: true,
            user_editable: true,
            rules: 'required|numeric|in:1000,2000,3000,4000'
          },
          {
            name: 'RCON_PORT',
            description: 'RCON Port',
            env_variable: 'RCON_PORT',
            default_value: '28016',
            user_viewable: true,
            user_editable: true,
            rules: 'required|numeric|between:1024,65535'
          },
          {
            name: 'RCON_PASSWORD',
            description: 'RCON Password',
            env_variable: 'RCON_PASSWORD',
            default_value: 'admin123',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string|min:6'
          }
        ]
      },
      {
        uuid: 'counter-strike-2',
        name: 'Counter-Strike 2',
        description: 'Counter-Strike 2 dedicated server',
        docker_image: 'joedwards32/cs2:latest',
        config: {
          startup: './cs2 -dedicated +map {{MAP}} +maxplayers {{MAX_PLAYERS}} +sv_password "{{SERVER_PASSWORD}}"',
          stop: 'quit',
          logs: {
            custom: false,
            location: 'logs'
          }
        },
        variables: [
          {
            name: 'MAP',
            description: 'Default Map',
            env_variable: 'MAP',
            default_value: 'de_dust2',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string'
          },
          {
            name: 'MAX_PLAYERS',
            description: 'Maximum Players',
            env_variable: 'MAX_PLAYERS',
            default_value: '32',
            user_viewable: true,
            user_editable: true,
            rules: 'required|numeric|min:2|max:64'
          },
          {
            name: 'SERVER_PASSWORD',
            description: 'Server Password',
            env_variable: 'SERVER_PASSWORD',
            default_value: '',
            user_viewable: true,
            user_editable: true,
            rules: 'string'
          },
          {
            name: 'SERVER_PORT',
            description: 'Server Port',
            env_variable: 'SERVER_PORT',
            default_value: '27015',
            user_viewable: true,
            user_editable: false,
            rules: 'required|numeric|between:1024,65535'
          }
        ]
      },
      {
        uuid: 'valheim',
        name: 'Valheim',
        description: 'Valheim dedicated server',
        docker_image: 'lloesche/valheim-server:latest',
        config: {
          startup: './valheim_server.x86_64 -name "{{SERVER_NAME}}" -port {{SERVER_PORT}} -world "{{WORLD_NAME}}" -password "{{SERVER_PASSWORD}}"',
          stop: 'quit',
          logs: {
            custom: false,
            location: 'logs'
          }
        },
        variables: [
          {
            name: 'SERVER_NAME',
            description: 'Server Name',
            env_variable: 'SERVER_NAME',
            default_value: 'Valheim Server',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string|max:255'
          },
          {
            name: 'WORLD_NAME',
            description: 'World Name',
            env_variable: 'WORLD_NAME',
            default_value: 'Dedicated',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string|max:255'
          },
          {
            name: 'SERVER_PASSWORD',
            description: 'Server Password',
            env_variable: 'SERVER_PASSWORD',
            default_value: 'password123',
            user_viewable: true,
            user_editable: true,
            rules: 'required|string|min:5'
          },
          {
            name: 'SERVER_PORT',
            description: 'Server Port',
            env_variable: 'SERVER_PORT',
            default_value: '2456',
            user_viewable: true,
            user_editable: false,
            rules: 'required|numeric|between:1024,65535'
          }
        ]
      }
    ];

    for (const egg of defaultEggs) {
      await this.saveEgg(egg);
      this.eggs.set(egg.uuid, egg);
    }
  }

  // Egg Management Routes
  async getEggs(req, res) {
    try {
      const eggs = Array.from(this.eggs.values());
      res.json(eggs);
    } catch (error) {
      console.error('❌ Erro ao buscar eggs:', error);
      res.status(500).json({ error: 'Erro ao buscar eggs' });
    }
  }

  async getEgg(req, res) {
    try {
      const { id } = req.params;
      const egg = this.eggs.get(id);
      
      if (!egg) {
        return res.status(404).json({ error: 'Egg não encontrado' });
      }
      
      res.json(egg);
    } catch (error) {
      console.error('❌ Erro ao buscar egg:', error);
      res.status(500).json({ error: 'Erro ao buscar egg' });
    }
  }

  async createEgg(req, res) {
    try {
      const egg = req.body;
      
      if (!egg.uuid || !egg.name || !egg.docker_image) {
        return res.status(400).json({ error: 'UUID, nome e imagem Docker são obrigatórios' });
      }
      
      await this.saveEgg(egg);
      this.eggs.set(egg.uuid, egg);
      
      console.log(`🥚 Egg criado: ${egg.name}`);
      res.json({ success: true, egg });
    } catch (error) {
      console.error('❌ Erro ao criar egg:', error);
      res.status(500).json({ error: 'Erro ao criar egg' });
    }
  }

  async updateEgg(req, res) {
    try {
      const { id } = req.params;
      const egg = req.body;
      
      if (!this.eggs.has(id)) {
        return res.status(404).json({ error: 'Egg não encontrado' });
      }
      
      egg.uuid = id;
      await this.saveEgg(egg);
      this.eggs.set(id, egg);
      
      console.log(`🥚 Egg atualizado: ${egg.name}`);
      res.json({ success: true, egg });
    } catch (error) {
      console.error('❌ Erro ao atualizar egg:', error);
      res.status(500).json({ error: 'Erro ao atualizar egg' });
    }
  }

  async deleteEgg(req, res) {
    try {
      const { id } = req.params;
      
      if (!this.eggs.has(id)) {
        return res.status(404).json({ error: 'Egg não encontrado' });
      }
      
      const eggPath = path.join(__dirname, 'eggs', `${id}.json`);
      await fs.unlink(eggPath);
      this.eggs.delete(id);
      
      console.log(`🗑️ Egg deletado: ${id}`);
      res.json({ success: true });
    } catch (error) {
      console.error('❌ Erro ao deletar egg:', error);
      res.status(500).json({ error: 'Erro ao deletar egg' });
    }
  }

  async saveEgg(egg) {
    const eggsDir = path.join(__dirname, 'eggs');
    await fs.mkdir(eggsDir, { recursive: true });
    
    const eggPath = path.join(eggsDir, `${egg.uuid}.json`);
    await fs.writeFile(eggPath, JSON.stringify(egg, null, 2));
  }

  // Server Configuration
  async createServerConfig(req, res) {
    const { id: serverId } = req.params;
    const config = req.body;

    try {
      console.log(`🔧 Criando configuração para servidor ${serverId}`);
      
      // Validar se o egg existe
      if (!this.eggs.has(config.eggId)) {
        return res.status(400).json({ error: 'Egg não encontrado' });
      }
      
      const egg = this.eggs.get(config.eggId);
      config.egg = egg;
      
      await this.saveServerConfig(serverId, config);
      this.serverConfigs.set(serverId, config);
      
      // Criar diretório do servidor
      const serverPath = this.getServerPath(serverId);
      await fs.mkdir(serverPath, { recursive: true });
      
      console.log(`✅ Configuração criada para servidor ${serverId} com egg ${egg.name}`);
      res.json({ success: true });
    } catch (error) {
      console.error(`❌ Erro ao criar configuração do servidor ${serverId}:`, error);
      res.status(500).json({ error: 'Falha ao criar configuração', details: error.message });
    }
  }

  async getServerConfig(req, res) {
    const { id: serverId } = req.params;
    
    try {
      const config = await this.loadServerConfig(serverId);
      res.json(config);
    } catch (error) {
      res.status(404).json({ error: 'Configuração não encontrada' });
    }
  }

  async updateServerConfig(req, res) {
    const { id: serverId } = req.params;
    const config = req.body;

    try {
      await this.saveServerConfig(serverId, config);
      this.serverConfigs.set(serverId, config);
      res.json({ success: true });
    } catch (error) {
      console.error(`❌ Erro ao atualizar configuração do servidor ${serverId}:`, error);
      res.status(500).json({ error: 'Falha ao atualizar configuração' });
    }
  }

  async installServer(req, res) {
    const { id: serverId } = req.params;
    
    try {
      console.log(`📦 Iniciando instalação do servidor ${serverId}`);
      
      const config = await this.loadServerConfig(serverId);
      // daemon/wings.js (continuação)
     const egg = config.egg;
     
     this.io.to(serverId).emit('server-status', { status: 'installing' });
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: 'Iniciando instalação do servidor...'
     });
     
     // Simular processo de instalação
     const serverPath = this.getServerPath(serverId);
     
     // Criar arquivos de configuração se especificados no egg
     if (egg.config && egg.config.files) {
       await this.createEggFiles(serverId, config);
     }
     
     // Simular download e instalação
     setTimeout(() => {
       this.io.to(serverId).emit('server-log', {
         timestamp: new Date().toISOString(),
         level: 'info',
         message: 'Baixando arquivos do servidor...'
       });
     }, 1000);
     
     setTimeout(() => {
       this.io.to(serverId).emit('server-log', {
         timestamp: new Date().toISOString(),
         level: 'info',
         message: 'Configurando servidor...'
       });
     }, 3000);
     
     setTimeout(() => {
       this.io.to(serverId).emit('server-status', { status: 'offline' });
       this.io.to(serverId).emit('server-log', {
         timestamp: new Date().toISOString(),
         level: 'info',
         message: 'Instalação concluída! Servidor pronto para uso.'
       });
     }, 8000);
     
     res.json({ success: true, message: 'Instalação iniciada' });
   } catch (error) {
     console.error(`❌ Erro na instalação do servidor ${serverId}:`, error);
     this.io.to(serverId).emit('server-status', { status: 'install_failed' });
     res.status(500).json({ error: 'Falha na instalação' });
   }
 }

 async reinstallServer(req, res) {
   const { id: serverId } = req.params;
   
   try {
     console.log(`🔄 Reinstalando servidor ${serverId}`);
     
     // Parar servidor se estiver rodando
     if (this.containers.has(serverId)) {
       await this.stopServer(req, { json: () => {} });
       await new Promise(resolve => setTimeout(resolve, 2000));
     }
     
     // Limpar dados do servidor
     const serverPath = this.getServerPath(serverId);
     try {
       await fs.rmdir(serverPath, { recursive: true });
       await fs.mkdir(serverPath, { recursive: true });
     } catch (error) {
       console.warn('⚠️ Erro ao limpar diretório do servidor:', error);
     }
     
     // Reinstalar
     await this.installServer(req, res);
   } catch (error) {
     console.error(`❌ Erro na reinstalação do servidor ${serverId}:`, error);
     res.status(500).json({ error: 'Falha na reinstalação' });
   }
 }

 async createEggFiles(serverId, config) {
   const serverPath = this.getServerPath(serverId);
   const egg = config.egg;
   
   if (!egg.config || !egg.config.files) return;
   
   for (const [fileName, fileConfig] of Object.entries(egg.config.files)) {
     const filePath = path.join(serverPath, fileName);
     
     if (fileConfig.parser === 'properties') {
       // Criar arquivo de propriedades
       let content = '';
       for (const [key, value] of Object.entries(fileConfig.find || {})) {
         const processedValue = this.processVariables(value, config);
         content += `${key}=${processedValue}\n`;
       }
       
       await fs.mkdir(path.dirname(filePath), { recursive: true });
       await fs.writeFile(filePath, content);
     } else if (fileConfig.parser === 'file') {
       // Criar arquivo simples
       const content = this.processVariables(fileConfig.find, config);
       await fs.mkdir(path.dirname(filePath), { recursive: true });
       await fs.writeFile(filePath, content);
     }
   }
 }

 processVariables(template, config) {
   if (typeof template !== 'string') return template;
   
   let result = template;
   
   // Processar variáveis do egg
   if (config.egg && config.egg.variables) {
     for (const variable of config.egg.variables) {
       const placeholder = `{{${variable.env_variable}}}`;
       const value = config.variables && config.variables[variable.env_variable] 
         ? config.variables[variable.env_variable] 
         : variable.default_value;
       
       result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
     }
   }
   
   // Variáveis do sistema
   result = result.replace(/{{SERVER_PORT}}/g, config.port || '25565');
   result = result.replace(/{{SERVER_MEMORY}}/g, (config.plan ? config.plan.ram * 1024 : 1024).toString());
   
   return result;
 }

 async createContainer(serverId, config) {
   const egg = config.egg;
   const serverPath = this.getServerPath(serverId);
   
   console.log(`🐳 Criando container ${serverId} com egg ${egg.name}`);
   
   // Processar variáveis de ambiente
   const environment = [];
   
   if (egg.variables) {
     for (const variable of egg.variables) {
       const value = config.variables && config.variables[variable.env_variable] 
         ? config.variables[variable.env_variable] 
         : variable.default_value;
       
       environment.push(`${variable.env_variable}=${value}`);
     }
   }
   
   // Adicionar variáveis padrão
   environment.push(`SERVER_PORT=${config.port}`);
   environment.push(`SERVER_MEMORY=${config.plan ? config.plan.ram * 1024 : 1024}`);
   environment.push('EULA=TRUE');
   
   const containerConfig = {
     Image: egg.docker_image,
     name: `pyro-server-${serverId}`,
     Env: environment,
     ExposedPorts: {
       [`${config.port}/tcp`]: {},
       [`${config.port}/udp`]: {}
     },
     HostConfig: {
       PortBindings: {
         [`${config.port}/tcp`]: [{ HostPort: config.port.toString() }],
         [`${config.port}/udp`]: [{ HostPort: config.port.toString() }]
       },
       Memory: config.plan ? config.plan.ram * 1024 * 1024 * 1024 : 1024 * 1024 * 1024,
       CpuShares: config.plan ? config.plan.cpu * 1024 : 1024,
       Binds: [
         `${serverPath}:/data`,
         `${serverPath}:/home/container`
       ],
       RestartPolicy: {
         Name: 'unless-stopped'
       }
     },
     WorkingDir: '/data',
     AttachStdout: true,
     AttachStderr: true,
     Tty: true,
     Cmd: egg.config && egg.config.startup ? ['/bin/bash', '-c', this.processVariables(egg.config.startup, config)] : undefined
   };

   // Verificar se a imagem existe
   try {
     await this.docker.getImage(egg.docker_image).inspect();
   } catch (error) {
     console.log(`📥 Fazendo pull da imagem ${egg.docker_image}...`);
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: `Baixando imagem Docker: ${egg.docker_image}`
     });
     await this.docker.pull(egg.docker_image);
   }

   return await this.docker.createContainer(containerConfig);
 }

 async startServer(req, res) {
   const { id: serverId } = req.params;
   
   try {
     console.log(`🚀 Iniciando servidor ${serverId}`);
     
     if (this.containers.has(serverId)) {
       return res.status(400).json({ error: 'Servidor já está rodando' });
     }

     const serverConfig = await this.loadServerConfig(serverId);
     
     // Verificar se está instalado
     if (!serverConfig.egg) {
       return res.status(400).json({ error: 'Servidor não está configurado' });
     }
     
     const container = await this.createContainer(serverId, serverConfig);
     await container.start();
     
     this.containers.set(serverId, container);
     this.setupContainerLogging(serverId, container);
     
     this.io.to(serverId).emit('server-status', { status: 'starting' });
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: 'Servidor iniciando...'
     });
     
     setTimeout(() => {
       this.io.to(serverId).emit('server-status', { status: 'online' });
       this.io.to(serverId).emit('server-log', {
         timestamp: new Date().toISOString(),
         level: 'info',
         message: 'Servidor online!'
       });
     }, 5000);

     console.log(`✅ Servidor ${serverId} iniciado com sucesso`);
     res.json({ success: true, status: 'starting' });
   } catch (error) {
     console.error(`❌ Erro ao iniciar servidor ${serverId}:`, error);
     this.io.to(serverId).emit('server-status', { status: 'error' });
     res.status(500).json({ error: 'Falha ao iniciar servidor', details: error.message });
   }
 }

 async stopServer(req, res) {
   const { id: serverId } = req.params;
   
   try {
     console.log(`🛑 Parando servidor ${serverId}`);
     
     const container = this.containers.get(serverId);
     
     if (!container) {
       return res.status(400).json({ error: 'Servidor não está rodando' });
     }

     this.io.to(serverId).emit('server-status', { status: 'stopping' });
     
     // Tentar parar graciosamente primeiro
     const config = await this.loadServerConfig(serverId);
     const egg = config.egg;
     
     if (egg && egg.config && egg.config.stop) {
       // Enviar comando de parada específico do jogo
       try {
         const exec = await container.exec({
           Cmd: ['sh', '-c', `echo "${egg.config.stop}" > /proc/1/fd/0`],
           AttachStdout: true,
           AttachStderr: true
         });
         await exec.start();
         
         // Aguardar um pouco para o servidor parar graciosamente
         await new Promise(resolve => setTimeout(resolve, 10000));
       } catch (error) {
         console.warn('⚠️ Erro ao enviar comando de parada gracioso:', error);
       }
     }
     
     await container.stop({ t: 10 });
     await container.remove();
     
     this.containers.delete(serverId);
     this.serverStats.delete(serverId);
     
     this.io.to(serverId).emit('server-status', { status: 'offline' });
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: 'Servidor parado.'
     });
     
     console.log(`✅ Servidor ${serverId} parado com sucesso`);
     res.json({ success: true, status: 'offline' });
   } catch (error) {
     console.error(`❌ Erro ao parar servidor ${serverId}:`, error);
     res.status(500).json({ error: 'Falha ao parar servidor', details: error.message });
   }
 }

 async restartServer(req, res) {
   const { id: serverId } = req.params;
   
   try {
     console.log(`🔄 Reiniciando servidor ${serverId}`);
     
     // Parar primeiro
     await this.stopServer(req, { json: () => {} });
     
     // Aguardar um pouco
     await new Promise(resolve => setTimeout(resolve, 3000));
     
     // Iniciar novamente
     await this.startServer(req, res);
   } catch (error) {
     console.error(`❌ Erro ao reiniciar servidor ${serverId}:`, error);
     res.status(500).json({ error: 'Falha ao reiniciar servidor', details: error.message });
   }
 }

 async killServer(req, res) {
   const { id: serverId } = req.params;
   
   try {
     console.log(`💀 Forçando parada do servidor ${serverId}`);
     
     const container = this.containers.get(serverId);
     
     if (!container) {
       return res.status(400).json({ error: 'Servidor não está rodando' });
     }

     await container.kill();
     await container.remove();
     
     this.containers.delete(serverId);
     this.serverStats.delete(serverId);
     
     this.io.to(serverId).emit('server-status', { status: 'offline' });
     
     res.json({ success: true, status: 'offline' });
   } catch (error) {
     console.error(`❌ Erro ao forçar parada do servidor ${serverId}:`, error);
     res.status(500).json({ error: 'Falha ao forçar parada', details: error.message });
   }
 }

 async setupContainerLogging(serverId, container) {
   try {
     const logStream = await container.logs({
       follow: true,
       stdout: true,
       stderr: true,
       timestamps: true
     });

     logStream.on('data', (chunk) => {
       const log = chunk.toString('utf8').trim();
       if (log) {
         const logData = {
           timestamp: new Date().toISOString(),
           message: this.cleanLogMessage(log),
           level: this.detectLogLevel(log)
         };
         
         // Emitir para clientes conectados
         this.io.to(serverId).emit('server-log', logData);
         
         // Salvar no arquivo
         this.saveLogToFile(serverId, logData);
       }
     });

     logStream.on('error', (error) => {
       console.error(`❌ Erro no stream de logs do servidor ${serverId}:`, error);
     });
   } catch (error) {
     console.error(`❌ Erro ao configurar logging do servidor ${serverId}:`, error);
   }
 }

 cleanLogMessage(log) {
   // Remover códigos de controle ANSI e timestamps do Docker
   return log
     .replace(/\u001b\[[0-9;]*m/g, '') // Remove cores ANSI
     .replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\d{6}\d{3}Z\s/, '') // Remove timestamp do Docker
     .replace(/^\[.*?\]\s/, '') // Remove prefixos entre colchetes
     .trim();
 }

 detectLogLevel(log) {
   const logLower = log.toLowerCase();
   if (logLower.includes('error') || logLower.includes('exception') || logLower.includes('fatal')) return 'error';
   if (logLower.includes('warn') || logLower.includes('warning')) return 'warning';
   if (logLower.includes('info') || logLower.includes('done')) return 'info';
   if (logLower.includes('debug')) return 'debug';
   return 'info';
 }

 async saveLogToFile(serverId, logData) {
   try {
     const logsDir = path.join(__dirname, 'logs', serverId);
     await fs.mkdir(logsDir, { recursive: true });
     
     const logFile = path.join(logsDir, `${new Date().toISOString().split('T')[0]}.log`);
     const logLine = `[${logData.timestamp}] [${logData.level.toUpperCase()}] ${logData.message}\n`;
     
     await fs.appendFile(logFile, logLine);
   } catch (error) {
     console.error(`❌ Erro ao salvar log do servidor ${serverId}:`, error);
   }
 }

 async executeCommand(serverId, command, socket = null) {
   const container = this.containers.get(serverId);
   if (!container) {
     const error = 'Servidor não está rodando';
     if (socket) {
       socket.emit('command-output', { command, output: error, error: true });
     }
     return;
   }

   try {
     console.log(`💻 Executando comando no servidor ${serverId}: ${command}`);
     
     // Enviar comando para o stdin do container
     const exec = await container.exec({
       Cmd: ['sh', '-c', `echo "${command}" > /proc/1/fd/0`],
       AttachStdout: true,
       AttachStderr: true,
       Tty: true
     });

     const stream = await exec.start({ Tty: true });
     
     // Emitir comando para logs
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: `> ${command}`
     });
     
     if (socket) {
       socket.emit('command-output', { 
         command, 
         output: `Comando enviado: ${command}`,
         success: true 
       });
     }
   } catch (error) {
     console.error(`❌ Erro ao executar comando no servidor ${serverId}:`, error);
     const errorMsg = `Erro: ${error.message}`;
     
     if (socket) {
       socket.emit('command-output', { command, output: errorMsg, error: true });
     }
   }
 }

 async sendCommand(req, res) {
   const { id: serverId } = req.params;
   const { command } = req.body;
   
   if (!command) {
     return res.status(400).json({ error: 'Comando é obrigatório' });
   }

   await this.executeCommand(serverId, command);
   res.json({ success: true, message: 'Comando enviado' });
 }

 startStatsMonitoring() {
   console.log('📊 Iniciando monitoramento de estatísticas...');
   
   setInterval(async () => {
     for (const [serverId, container] of this.containers.entries()) {
       try {
         const stats = await container.stats({ stream: false });
         const processedStats = this.processContainerStats(stats);
         
         this.serverStats.set(serverId, processedStats);
         this.io.to(serverId).emit('server-stats', processedStats);
       } catch (error) {
         // Silencioso para não poluir logs
       }
     }
   }, 5000); // Atualizar a cada 5 segundos
 }

 processContainerStats(stats) {
   try {
     // Calcular CPU
     const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
     const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
     const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * (stats.cpu_stats.online_cpus || 1) * 100 : 0;

     // Calcular Memória
     const memoryUsage = stats.memory_stats.usage || 0;
     const memoryLimit = stats.memory_stats.limit || 1;
     const memoryPercent = (memoryUsage / memoryLimit) * 100;

     // Rede
     const networks = stats.networks || {};
     const networkKeys = Object.keys(networks);
     const networkData = networkKeys.length > 0 ? networks[networkKeys[0]] : { rx_bytes: 0, tx_bytes: 0 };

     return {
       cpu: Math.min(Math.round(cpuPercent || 0), 100),
       memory: {
         used: Math.round(memoryUsage / 1024 / 1024), // MB
         total: Math.round(memoryLimit / 1024 / 1024), // MB
         percent: Math.min(Math.round(memoryPercent || 0), 100)
       },
       network: {
         rx: networkData.rx_bytes || 0,
         tx: networkData.tx_bytes || 0
       }
     };
   } catch (error) {
     console.error('Erro ao processar estatísticas:', error);
     return {
       cpu: 0,
       memory: { used: 0, total: 0, percent: 0 },
       network: { rx: 0, tx: 0 }
     };
   }
 }

 async getServerStats(req, res) {
   const { id: serverId } = req.params;
   const stats = this.serverStats.get(serverId);
   
   if (!stats) {
     return res.status(404).json({ error: 'Estatísticas não encontradas' });
   }
   
   res.json(stats);
 }

 async getServerLogs(req, res) {
   const { id: serverId } = req.params;
   const { lines = 100, since } = req.query;
   
   try {
     const logsDir = path.join(__dirname, 'logs', serverId);
     const today = new Date().toISOString().split('T')[0];
     const logFile = path.join(logsDir, `${today}.log`);
     
     try {
       const logContent = await fs.readFile(logFile, 'utf8');
       const logLines = logContent.split('\n')
         .filter(line => line.trim())
         .slice(-parseInt(lines))
         .map(line => {
           const match = line.match(/\[(.*?)\] \[(.*?)\] (.*)/);
           return match ? {
             id: Math.random().toString(36).substr(2, 9),
             timestamp: match[1],
             level: match[2].toLowerCase(),
             message: match[3]
           } : null;
         })
         .filter(Boolean);
       
       res.json(logLines);
     } catch (fileError) {
       // Se arquivo não existe, retornar array vazio
       res.json([]);
     }
   } catch (error) {
     console.error(`❌ Erro ao carregar logs do servidor ${serverId}:`, error);
     res.status(500).json({ error: 'Erro ao carregar logs' });
   }
 }

 async getServerFiles(req, res) {
   const { id: serverId } = req.params;
   const { path: filePath = '/' } = req.query;
   
   try {
     const serverPath = this.getServerPath(serverId);
     const fullPath = path.join(serverPath, filePath);
     
     // Verificar se o caminho está dentro do diretório do servidor (segurança)
     if (!fullPath.startsWith(serverPath)) {
       return res.status(400).json({ error: 'Caminho inválido' });
     }
     
     const stats = await fs.stat(fullPath);
     
     if (stats.isDirectory()) {
       const files = await fs.readdir(fullPath);
       const fileList = await Promise.all(files.map(async (file) => {
         try {
           const fileStats = await fs.stat(path.join(fullPath, file));
           return {
             name: file,
             type: fileStats.isDirectory() ? 'directory' : 'file',
             size: fileStats.size,
             modified: fileStats.mtime.toISOString(),
             permissions: (fileStats.mode & parseInt('777', 8)).toString(8)
           };
         } catch (err) {
           return {
             name: file,
             type: 'unknown',
             size: 0,
             modified: new Date().toISOString(),
             permissions: '000'
           };
         }
       }));
       
       res.json(fileList.sort((a, b) => {
         if (a.type === 'directory' && b.type !== 'directory') return -1;
         if (a.type !== 'directory' && b.type === 'directory') return 1;
         return a.name.localeCompare(b.name);
       }));
     } else {
       const content = await fs.readFile(fullPath, 'utf8');
       res.json({ 
         content,
         size: stats.size,
         modified: stats.mtime.toISOString()
       });
     }
   } catch (error) {
     console.error(`❌ Erro ao acessar arquivos do servidor ${serverId}:`, error);
     if (error.code === 'ENOENT') {
       res.status(404).json({ error: 'Arquivo ou diretório não encontrado' });
     } else {
       res.status(500).json({ error: 'Erro ao acessar arquivos' });
     }
   }
 }

 async uploadFile(req, res) {
   const { id: serverId } = req.params;
   const { path: filePath, content, encoding = 'utf8' } = req.body;
   
   if (!filePath || content === undefined) {
     return res.status(400).json({ error: 'Caminho e conteúdo são obrigatórios' });
   }
   
   try {
     const serverPath = this.getServerPath(serverId);
     const fullPath = path.join(serverPath, filePath);
     
     // Verificar segurança do caminho
     if (!fullPath.startsWith(serverPath)) {
       return res.status(400).json({ error: 'Caminho inválido' });
     }
     
     await fs.mkdir(path.dirname(fullPath), { recursive: true });
     
     if (encoding === 'base64') {
       const buffer = Buffer.from(content, 'base64');
       await fs.writeFile(fullPath, buffer);
     } else {
       await fs.writeFile(fullPath, content, encoding);
     }
     
     console.log(`📁 Arquivo criado: ${filePath} no servidor ${serverId}`);
     res.json({ success: true, message: 'Arquivo criado com sucesso' });
   } catch (error) {
     console.error(`❌ Erro ao criar arquivo no servidor ${serverId}:`, error);
     res.status(500).json({ error: 'Erro ao salvar arquivo' });
   }
 }

 async updateFile(req, res) {
   const { id: serverId } = req.params;
   const { path: filePath, content } = req.body;
   
   if (!filePath || content === undefined) {
     return res.status(400).json({ error: 'Caminho e conteúdo são obrigatórios' });
   }
   
   try {
     const serverPath = this.getServerPath(serverId);
     const fullPath = path.join(serverPath, filePath);
     
     // Verificar segurança do caminho
     if (!fullPath.startsWith(serverPath)) {
       return res.status(400).json({ error: 'Caminho inválido' });
     }
     
     // Fazer backup antes de modificar
     try {
       const backupPath = `${fullPath}.backup.${Date.now()}`;
       await fs.copyFile(fullPath, backupPath);
     } catch (backupError) {
       console.warn(`⚠️ Não foi possível criar backup de ${filePath}`);
     }
     
     await fs.writeFile(fullPath, content, 'utf8');
     
     console.log(`📝 Arquivo atualizado: ${filePath} no servidor ${serverId}`);
     res.json({ success: true, message: 'Arquivo atualizado com sucesso' });
   } catch (error) {
     console.error(`❌ Erro ao atualizar arquivo no servidor ${serverId}:`, error);
     res.status(500).json({ error: 'Erro ao atualizar arquivo' });
   }
 }

 async deleteFile(req, res) {
   const { id: serverId } = req.params;
   const { path: filePath } = req.query;
   
   if (!filePath) {
     return res.status(400).json({ error: 'Caminho é obrigatório' });
   }
   
   try {
     const serverPath = this.getServerPath(serverId);
     const fullPath = path.join(serverPath, filePath);
     
     // Verificar segurança do caminho
     if (!fullPath.startsWith(serverPath)) {
       return res.status(400).json({ error: 'Caminho inválido' });
     }
     
     const stats = await fs.stat(fullPath);
     
     if (stats.isDirectory()) {
       await fs.rmdir(fullPath, { recursive: true });
     } else {
       await fs.unlink(fullPath);
     }
     
     console.log(`🗑️ Arquivo/diretório deletado: ${filePath} no servidor ${serverId}`);
     res.json({ success: true, message: 'Arquivo deletado com sucesso' });
   } catch (error) {
     console.error(`❌ Erro ao deletar arquivo no servidor ${serverId}:`, error);
     if (error.code === 'ENOENT') {
       res.status(404).json({ error: 'Arquivo não encontrado' });
     } else {
       res.status(500).json({ error: 'Erro ao deletar arquivo' });
     }
   }
 }

 async copyFile(req, res) {
   const { id: serverId } = req.params;
   const { source, destination } = req.body;
   
   try {
     const serverPath = this.getServerPath(serverId);
     const sourcePath = path.join(serverPath, source);
     const destPath = path.join(serverPath, destination);
     
     if (!sourcePath.startsWith(serverPath) || !destPath.startsWith(serverPath)) {
       return res.status(400).json({ error: 'Caminho inválido' });
     }
     
     await fs.copyFile(sourcePath, destPath);
     res.json({ success: true, message: 'Arquivo copiado com sucesso' });
   } catch (error) {
     console.error(`❌ Erro ao copiar arquivo:`, error);
     res.status(500).json({ error: 'Erro ao copiar arquivo' });
   }
 }
 // daemon/wings.js (continuação)
 async renameFile(req, res) {
   const { id: serverId } = req.params;
   const { oldPath, newPath } = req.body;
   
   try {
     const serverPath = this.getServerPath(serverId);
     const oldFullPath = path.join(serverPath, oldPath);
     const newFullPath = path.join(serverPath, newPath);
     
     if (!oldFullPath.startsWith(serverPath) || !newFullPath.startsWith(serverPath)) {
       return res.status(400).json({ error: 'Caminho inválido' });
     }
     
     await fs.rename(oldFullPath, newFullPath);
     console.log(`📝 Arquivo renomeado: ${oldPath} -> ${newPath} no servidor ${serverId}`);
     res.json({ success: true, message: 'Arquivo renomeado com sucesso' });
   } catch (error) {
     console.error(`❌ Erro ao renomear arquivo:`, error);
     res.status(500).json({ error: 'Erro ao renomear arquivo' });
   }
 }

 async compressFiles(req, res) {
   const { id: serverId } = req.params;
   const { files, archiveName } = req.body;
   
   try {
     // TODO: Implementar compressão de arquivos usando tar
     res.json({ success: true, message: 'Funcionalidade de compressão em desenvolvimento' });
   } catch (error) {
     res.status(500).json({ error: 'Erro ao comprimir arquivos' });
   }
 }

 async extractFiles(req, res) {
   const { id: serverId } = req.params;
   const { archivePath, destination } = req.body;
   
   try {
     // TODO: Implementar extração de arquivos usando tar
     res.json({ success: true, message: 'Funcionalidade de extração em desenvolvimento' });
   } catch (error) {
     res.status(500).json({ error: 'Erro ao extrair arquivos' });
   }
 }

 setupCleanupTasks() {
   // Limpeza de logs antigos (executa diariamente às 3:00)
   cron.schedule('0 3 * * *', async () => {
     console.log('🧹 Executando limpeza de logs antigos...');
     await this.cleanupOldLogs();
   });

   // Limpeza de containers órfãos (executa a cada 6 horas)
   cron.schedule('0 */6 * * *', async () => {
     console.log('🧹 Limpando containers órfãos...');
     await this.cleanupOrphanedContainers();
   });

   // Verificação de status dos containers (executa a cada minuto)
   cron.schedule('* * * * *', async () => {
     await this.checkContainerStatus();
   });

   console.log('✅ Tarefas de limpeza configuradas');
 }

 async cleanupOldLogs() {
   try {
     const logsDir = path.join(__dirname, 'logs');
     const servers = await fs.readdir(logsDir);
     
     for (const serverId of servers) {
       const serverLogsDir = path.join(logsDir, serverId);
       const logFiles = await fs.readdir(serverLogsDir);
       
       for (const logFile of logFiles) {
         const filePath = path.join(serverLogsDir, logFile);
         const stats = await fs.stat(filePath);
         const age = Date.now() - stats.mtime.getTime();
         const thirtyDays = 30 * 24 * 60 * 60 * 1000;
         
         if (age > thirtyDays) {
           await fs.unlink(filePath);
           console.log(`🗑️ Log antigo removido: ${logFile}`);
         }
       }
     }
   } catch (error) {
     console.error('❌ Erro na limpeza de logs:', error);
   }
 }

 async cleanupOrphanedContainers() {
   try {
     const containers = await this.docker.listContainers({ all: true });
     const pyroContainers = containers.filter(container => 
       container.Names.some(name => name.includes('pyro-server-'))
     );

     for (const containerInfo of pyroContainers) {
       const serverId = containerInfo.Names[0].replace('/pyro-server-', '');
       
       // Verificar se o servidor ainda existe na configuração
       try {
         await this.loadServerConfig(serverId);
       } catch (error) {
         // Servidor não existe mais, remover container
         const container = this.docker.getContainer(containerInfo.Id);
         
         if (containerInfo.State === 'running') {
           await container.stop();
         }
         
         await container.remove();
         console.log(`🧹 Container órfão removido: ${containerInfo.Names[0]}`);
       }
     }
   } catch (error) {
     console.error('❌ Erro na limpeza de containers:', error);
   }
 }

 async checkContainerStatus() {
   try {
     for (const [serverId, container] of this.containers.entries()) {
       try {
         const containerInfo = await container.inspect();
         
         if (!containerInfo.State.Running) {
           // Container parou inesperadamente
           this.containers.delete(serverId);
           this.serverStats.delete(serverId);
           
           this.io.to(serverId).emit('server-status', { status: 'offline' });
           this.io.to(serverId).emit('server-log', {
             timestamp: new Date().toISOString(),
             level: 'warning',
             message: 'Servidor parou inesperadamente'
           });
           
           console.log(`⚠️ Servidor ${serverId} parou inesperadamente`);
         }
       } catch (error) {
         // Container não existe mais
         this.containers.delete(serverId);
         this.serverStats.delete(serverId);
         
         this.io.to(serverId).emit('server-status', { status: 'offline' });
       }
     }
   } catch (error) {
     // Erro silencioso para não poluir logs
   }
 }

 getServerPath(serverId) {
   return path.join(__dirname, 'servers', serverId);
 }

 async loadServerConfig(serverId) {
   try {
     const configPath = path.join(__dirname, 'configs', `${serverId}.json`);
     const configData = await fs.readFile(configPath, 'utf8');
     const config = JSON.parse(configData);
     
     // Carregar egg se não estiver no config
     if (config.eggId && !config.egg) {
       config.egg = this.eggs.get(config.eggId);
     }
     
     return config;
   } catch (error) {
     throw new Error(`Configuração do servidor ${serverId} não encontrada`);
   }
 }

 async saveServerConfig(serverId, config) {
   const configsDir = path.join(__dirname, 'configs');
   await fs.mkdir(configsDir, { recursive: true });
   
   const configPath = path.join(configsDir, `${serverId}.json`);
   await fs.writeFile(configPath, JSON.stringify(config, null, 2));
 }

 start(port = 8080) {
   this.server.listen(port, () => {
     console.log(`🔥 Wings Daemon rodando na porta ${port}`);
     console.log(`📝 Endpoints disponíveis:`);
     console.log(`   - GET  /health - Status do daemon`);
     console.log(`   - GET  /api/eggs - Listar eggs`);
     console.log(`   - POST /api/servers/:id/config - Criar configuração`);
     console.log(`   - POST /api/servers/:id/start - Iniciar servidor`);
     console.log(`   - POST /api/servers/:id/stop - Parar servidor`);
     console.log(`   - POST /api/servers/:id/install - Instalar servidor`);
     console.log(`   - GET  /api/servers/:id/stats - Estatísticas do servidor`);
     console.log(`   - GET  /api/servers/:id/logs - Logs do servidor`);
     console.log(`   - GET  /api/servers/:id/files - Gerenciar arquivos`);
     console.log(`🌐 WebSocket disponível para comunicação em tempo real`);
   });
 }
}

// Inicializar o daemon
const daemon = new WingsDaemon();
daemon.start(process.env.PORT || 8080);

// Graceful shutdown
process.on('SIGTERM', async () => {
 console.log('🛑 Recebido SIGTERM, parando containers...');
 
 for (const [serverId, container] of daemon.containers.entries()) {
   try {
     console.log(`🛑 Parando servidor ${serverId}...`);
     await container.stop({ t: 10 });
     await container.remove();
   } catch (error) {
     console.error(`❌ Erro ao parar servidor ${serverId}:`, error);
   }
 }
 
 process.exit(0);
});

process.on('SIGINT', async () => {
 console.log('🛑 Recebido SIGINT, parando daemon...');
 process.exit(0);
});

module.exports = WingsDaemon;