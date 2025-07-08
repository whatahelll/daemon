// daemon/wings.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Docker = require('dockerode');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

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
    this.containers = new Map();
    this.serverStats = new Map();
    this.serverConfigs = new Map();
    this.eggs = new Map();
    this.dockerImages = new Map();
    
    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.startStatsMonitoring();
    this.setupCleanupTasks();
    this.loadDockerImages();
    this.loadEggs();
    
    console.log('🔥 Wings Daemon inicializando...');
  }

  setupMiddleware() {
    this.app.use(cors({
      origin: process.env.PANEL_URL || ["http://localhost:3000", "https://localhost:3000"],
      credentials: true
    }));
    this.app.use(express.json({ limit: '50mb' }));
    this.app.use('/health', (req, res) => res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      containers: this.containers.size,
      eggs: this.eggs.size,
      images: this.dockerImages.size
    }));
  }

  setupRoutes() {
    // Server configuration
    this.app.post('/api/servers/:id/config', this.createServerConfig.bind(this));
    this.app.get('/api/servers/:id/config', this.getServerConfig.bind(this));
    
    // Server control
    this.app.post('/api/servers/:id/start', this.startServer.bind(this));
    this.app.post('/api/servers/:id/stop', this.stopServer.bind(this));
    this.app.post('/api/servers/:id/restart', this.restartServer.bind(this));
    this.app.post('/api/servers/:id/kill', this.killServer.bind(this));
    this.app.post('/api/servers/:id/install', this.installServer.bind(this));
    this.app.post('/api/servers/:id/reinstall', this.reinstallServer.bind(this));
    
    // Stats and logs
    this.app.get('/api/servers/:id/stats', this.getServerStats.bind(this));
    this.app.get('/api/servers/:id/logs', this.getServerLogs.bind(this));
    
    // Commands
    this.app.post('/api/servers/:id/command', this.sendCommand.bind(this));
    
    // File management
    this.app.get('/api/servers/:id/files', this.getServerFiles.bind(this));
    this.app.post('/api/servers/:id/files', this.uploadFile.bind(this));
    this.app.put('/api/servers/:id/files', this.updateFile.bind(this));
    this.app.delete('/api/servers/:id/files', this.deleteFile.bind(this));
    
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

  loadDockerImages() {
    // Carregar imagens do .env
    this.dockerImages.set('java_8', process.env.DOCKER_IMAGES_JAVA_8 || 'ghcr.io/pterodactyl/yolks:java_8');
    this.dockerImages.set('java_11', process.env.DOCKER_IMAGES_JAVA_11 || 'ghcr.io/pterodactyl/yolks:java_11');
    this.dockerImages.set('java_16', process.env.DOCKER_IMAGES_JAVA_16 || 'ghcr.io/pterodactyl/yolks:java_16');
    this.dockerImages.set('java_17', process.env.DOCKER_IMAGES_JAVA_17 || 'ghcr.io/pterodactyl/yolks:java_17');
    this.dockerImages.set('java_21', process.env.DOCKER_IMAGES_JAVA_21 || 'ghcr.io/pterodactyl/yolks:java_21');
    
    this.dockerImages.set('nodejs_12', process.env.DOCKER_IMAGES_NODE_12 || 'ghcr.io/pterodactyl/yolks:nodejs_12');
    this.dockerImages.set('nodejs_14', process.env.DOCKER_IMAGES_NODE_14 || 'ghcr.io/pterodactyl/yolks:nodejs_14');
    this.dockerImages.set('nodejs_16', process.env.DOCKER_IMAGES_NODE_16 || 'ghcr.io/pterodactyl/yolks:nodejs_16');
    this.dockerImages.set('nodejs_18', process.env.DOCKER_IMAGES_NODE_18 || 'ghcr.io/pterodactyl/yolks:nodejs_18');
    
    this.dockerImages.set('python_38', process.env.DOCKER_IMAGES_PYTHON_38 || 'ghcr.io/pterodactyl/yolks:python_3.8');
    this.dockerImages.set('python_39', process.env.DOCKER_IMAGES_PYTHON_39 || 'ghcr.io/pterodactyl/yolks:python_3.9');
    this.dockerImages.set('python_310', process.env.DOCKER_IMAGES_PYTHON_310 || 'ghcr.io/pterodactyl/yolks:python_3.10');
    
    this.dockerImages.set('installer', process.env.DOCKER_IMAGES_INSTALLER || 'ghcr.io/pterodactyl/installers:debian');
    this.dockerImages.set('alpine', process.env.DOCKER_IMAGES_ALPINE || 'ghcr.io/pterodactyl/yolks:debian');
    this.dockerImages.set('ubuntu', process.env.DOCKER_IMAGES_UBUNTU || 'ghcr.io/pterodactyl/yolks:ubuntu');
    
    console.log(`✅ ${this.dockerImages.size} imagens Docker carregadas`);
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
            
            const eggId = egg.uuid || egg.name.toLowerCase().replace(/[^a-z0-9]/g, '-');
            this.eggs.set(eggId, egg);
            console.log(`🥚 Egg carregado: ${egg.name} (${eggId})`);
          } catch (error) {
            console.error(`❌ Erro ao carregar egg ${eggFile}:`, error);
          }
        }
      }
      
      if (this.eggs.size === 0) {
        await this.createDefaultEggs();
      }
      
      console.log(`✅ ${this.eggs.size} eggs carregados`);
    } catch (error) {
      console.error('❌ Erro ao carregar eggs:', error);
    }
  }

  async createDefaultEggs() {
    // Minecraft Vanilla
    const minecraftEgg = {
      "uuid": "minecraft-vanilla",
      "name": "Vanilla Minecraft",
      "author": "support@pterodactyl.io",
      "description": "Minecraft Java Edition server using the vanilla server jar.",
      "features": ["eula", "java_version", "pid_limit"],
      "docker_images": {
        "Java 8": this.dockerImages.get('java_8'),
        "Java 11": this.dockerImages.get('java_11'),
        "Java 16": this.dockerImages.get('java_16'),
        "Java 17": this.dockerImages.get('java_17'),
        "Java 21": this.dockerImages.get('java_21')
      },
      "startup": "java -Xms128M -Xmx{{SERVER_MEMORY}}M -Dterminal.jline=false -Dterminal.ansi=true -jar {{SERVER_JARFILE}}",
      "config": {
        "files": {
          "server.properties": {
            "parser": "properties",
            "find": {
              "server-port": "{{server.build.default.port}}",
              "enable-query": "true",
              "query.port": "{{server.build.default.port}}",
              "max-players": "{{server.build.env.MAX_PLAYERS}}",
              "motd": "{{server.build.env.MOTD}}",
              "allow-flight": "{{server.build.env.ALLOW_FLIGHT}}",
              "view-distance": "{{server.build.env.VIEW_DISTANCE}}",
              "gamemode": "{{server.build.env.GAMEMODE}}",
              "force-gamemode": "{{server.build.env.FORCE_GAMEMODE}}",
              "hardcore": "{{server.build.env.HARDCORE}}",
              "white-list": "{{server.build.env.WHITELIST}}",
              "enable-rcon": "true",
              "rcon.port": "{{server.build.default.port}}",
              "rcon.password": "{{server.build.env.RCON_PASSWORD}}"
            }
          },
          "eula.txt": {
            "parser": "file",
            "find": {
              "eula": "{{server.build.env.EULA}}"
            }
          }
        },
        "startup": {
          "done": ")! For help, type \"help\""
        },
        "stop": "stop",
        "logs": {
          "custom": false,
          "location": "logs/latest.log"
        }
      },
      "scripts": {
        "installation": {
          "script": "#!/bin/bash\ncd /mnt/server\n\napt update\napt install -y curl jq\n\necho \"eula=${EULA}\" > eula.txt\n\nif [ \"${MINECRAFT_VERSION}\" == \"latest\" ] || [ \"${MINECRAFT_VERSION}\" == \"\" ]; then\n    echo \"Downloading latest Minecraft server...\"\n    DOWNLOAD_URL=$(curl -sSL https://launchermeta.mojang.com/mc/game/version_manifest.json | jq -r '.latest.release as $latest | .versions[] | select(.id == $latest) | .url')\n    DOWNLOAD_URL=$(curl -sSL $DOWNLOAD_URL | jq -r '.downloads.server.url')\nelse\n    echo \"Downloading Minecraft ${MINECRAFT_VERSION}...\"\n    DOWNLOAD_URL=$(curl -sSL https://launchermeta.mojang.com/mc/game/version_manifest.json | jq -r --arg VERSION \"$MINECRAFT_VERSION\" '.versions[] | select(.id == $VERSION) | .url')\n    DOWNLOAD_URL=$(curl -sSL $DOWNLOAD_URL | jq -r '.downloads.server.url')\nfi\n\nif [ -z \"$DOWNLOAD_URL\" ]; then\n    echo \"Error: Could not find download URL for version ${MINECRAFT_VERSION}\"\n    exit 1\nfi\n\necho \"Download URL: $DOWNLOAD_URL\"\ncurl -o ${SERVER_JARFILE} \"$DOWNLOAD_URL\"\n\nif [ ! -f \"${SERVER_JARFILE}\" ]; then\n    echo \"Error: Failed to download server jar\"\n    exit 1\nfi\n\necho \"Installation completed!\"",
          "container": this.dockerImages.get('installer'),
          "entrypoint": "bash"
        }
      },
      "variables": [
        {
          "name": "Server Jar File",
          "description": "The name of the server jarfile to run the server with.",
          "env_variable": "SERVER_JARFILE",
          "default_value": "server.jar",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:20",
          "field_type": "text"
        },
        {
          "name": "Minecraft Version",
          "description": "The version of Minecraft to download.",
          "env_variable": "MINECRAFT_VERSION",
          "default_value": "latest",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:20",
          "field_type": "text"
        },
        {
          "name": "Server Memory",
          "description": "The maximum amount of memory to allow for the Minecraft server to use.",
          "env_variable": "SERVER_MEMORY",
          "default_value": "1024",
          "user_viewable": false,
          "user_editable": false,
          "rules": "required|numeric|min:128",
          "field_type": "text"
        },
        {
          "name": "EULA",
          "description": "Do you agree to the Minecraft EULA?",
          "env_variable": "EULA",
          "default_value": "true",
          "user_viewable": false,
          "user_editable": false,
          "rules": "required|string|in:true",
          "field_type": "text"
        },
        {
          "name": "Maximum Players",
          "description": "The maximum amount of players that can join the server at one time.",
          "env_variable": "MAX_PLAYERS",
          "default_value": "20",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|numeric|min:1",
          "field_type": "text"
        },
        {
          "name": "MOTD",
          "description": "This is the message that is displayed in the server list of the client, below the name.",
          "env_variable": "MOTD",
          "default_value": "A Minecraft Server powered by Pyro",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:59",
          "field_type": "text"
        },
        {
          "name": "Allow Flight",
          "description": "Allows users to use flight on your server while in Survival mode.",
          "env_variable": "ALLOW_FLIGHT",
          "default_value": "false",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|in:true,false",
          "field_type": "text"
        },
        {
          "name": "View Distance",
          "description": "Sets the amount of world data the server sends the client.",
          "env_variable": "VIEW_DISTANCE",
          "default_value": "10",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|numeric|min:3|max:15",
          "field_type": "text"
        },
        {
          "name": "Game Mode",
          "description": "Defines the mode of gameplay.",
          "env_variable": "GAMEMODE",
          "default_value": "survival",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|in:survival,creative,adventure,spectator",
          "field_type": "text"
        },
        {
          "name": "Force Gamemode",
          "description": "Forces players to join in the default game mode.",
          "env_variable": "FORCE_GAMEMODE",
          "default_value": "false",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|in:true,false",
          "field_type": "text"
        },
        {
          "name": "Hardcore",
          "description": "If set to true, server difficulty is ignored and set to hard.",
          "env_variable": "HARDCORE",
          "default_value": "false",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|in:true,false",
          "field_type": "text"
        },
        {
          "name": "Whitelist",
          "description": "Enables a whitelist on the server.",
          "env_variable": "WHITELIST",
          "default_value": "false",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|in:true,false",
          "field_type": "text"
        },
        {
          "name": "RCON Password",
          "description": "A password to use for RCON connections.",
          "env_variable": "RCON_PASSWORD",
          "default_value": "pyromc",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:20",
          "field_type": "text"
        }
      ]
    };

    // ARK: Survival Evolved
    const arkEgg = {
      "uuid": "ark-survival-evolved",
      "name": "ARK: Survival Evolved",
      "author": "support@pterodactyl.io",
      "description": "ARK: Survival Evolved dedicated server.",
      "features": ["steam_disk_space"],
      "docker_images": {
        "SteamCMD Debian": this.dockerImages.get('installer')
      },
      "startup": "./ShooterGameServer TheIsland?listen?SessionName={{SESSION_NAME}}?ServerPassword={{SERVER_PASSWORD}}?ServerAdminPassword={{ADMIN_PASSWORD}}?Port={{SERVER_PORT}}?QueryPort={{QUERY_PORT}}?MaxPlayers={{MAX_PLAYERS}} -server -log",
      "config": {
        "files": {},
        "startup": {
          "done": "Setting breakpad minidump AppID"
        },
        "stop": "^C",
        "logs": {
          "custom": false,
          "location": "logs/latest.log"
        }
      },
      "scripts": {
        "installation": {
          "script": "#!/bin/bash\ncd /mnt/server\n\napt update\napt install -y curl lib32gcc-s1\n\ncurl -sSL -o steamcmd.tar.gz https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz\ntar -xzvf steamcmd.tar.gz\nrm steamcmd.tar.gz\n\n./steamcmd.sh +force_install_dir /mnt/server +login anonymous +app_update 376030 validate +quit\n\necho \"ARK installation completed!\"",
          "container": this.dockerImages.get('installer'),
          "entrypoint": "bash"
        }
      },
      "variables": [
        {
          "name": "Session Name",
          "description": "The name of your ARK server",
          "env_variable": "SESSION_NAME",
          "default_value": "Pyro ARK Server",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:50",
          "field_type": "text"
        },
        {
          "name": "Server Password",
          "description": "Password required to join the server",
          "env_variable": "SERVER_PASSWORD",
          "default_value": "",
          "user_viewable": true,
          "user_editable": true,
          "rules": "nullable|string|max:50",
          "field_type": "text"
        },
        {
          "name": "Admin Password",
          "description": "Password for server administration",
          "env_variable": "ADMIN_PASSWORD",
          "default_value": "changeme123",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:50",
          "field_type": "text"
        },
        {
          "name": "Server Port",
          "description": "The main port for the server",
          "env_variable": "SERVER_PORT",
          "default_value": "7777",
          "user_viewable": true,
          "user_editable": false,
          "rules": "required|numeric",
          "field_type": "text"
        },
        {
          "name": "Query Port",
          "description": "The query port for the server",
          "env_variable": "QUERY_PORT",
          "default_value": "27015",
          "user_viewable": true,
          "user_editable": false,
          "rules": "required|numeric",
          "field_type": "text"
        },
        {
          "name": "Maximum Players",
          "description": "The maximum number of players allowed on the server",
          "env_variable": "MAX_PLAYERS",
          "default_value": "10",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|numeric|min:1|max:100",
          "field_type": "text"
        }
      ]
    };

    // Terraria
    const terrariaEgg = {
      "uuid": "terraria",
      "name": "Terraria",
      "author": "support@pterodactyl.io",
      "description": "Terraria dedicated server using TShock.",
      "features": [],
      "docker_images": {
        "TShock": this.dockerImages.get('ubuntu')
      },
      "startup": "mono --server --gc=sgen -O=all TerrariaServer.exe -port {{SERVER_PORT}} -maxplayers {{MAX_PLAYERS}} -world /home/container/worlds/{{WORLD_NAME}}.wld -autocreate {{WORLD_SIZE}} -worldname {{WORLD_NAME}}",
      "config": {
        "files": {},
        "startup": {
          "done": "Server started"
        },
        "stop": "exit",
        "logs": {
          "custom": false,
          "location": "ServerLog.txt"
        }
      },
      "scripts": {
        "installation": {
          "script": "#!/bin/bash\ncd /mnt/server\n\napt update\napt install -y wget unzip mono-complete\n\nwget -O tshock.zip https://github.com/Pryaxis/TShock/releases/download/v5.2.0/TShock-5.2.0-for-Terraria-1.4.4.9-linux-x64-Release.zip\nunzip tshock.zip\nrm tshock.zip\n\nmkdir -p worlds\nchmod +x TerrariaServer*\n\necho \"TShock installation completed!\"",
          "container": this.dockerImages.get('installer'),
          "entrypoint": "bash"
        }
      },
      "variables": [
        {
          "name": "World Name",
          "description": "The name of the world file",
          "env_variable": "WORLD_NAME",
          "default_value": "world",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:20",
          "field_type": "text"
        },
        {
          "name": "World Size",
          "description": "The size of the world (1=small, 2=medium, 3=large)",
          "env_variable": "WORLD_SIZE",
          "default_value": "2",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|numeric|in:1,2,3",
          "field_type": "text"
        },
        {
          "name": "Maximum Players",
          "description": "The maximum number of players",
          "env_variable": "MAX_PLAYERS",
          "default_value": "8",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|numeric|min:1|max:255",
          "field_type": "text"
        }
      ]
    };

    // Garry's Mod
    const gmodEgg = {
      "uuid": "garrys-mod",
      "name": "Garry's Mod",
      "author": "support@pterodactyl.io",
      "description": "Garry's Mod dedicated server.",
      "features": ["steam_disk_space"],
      "docker_images": {
        "SteamCMD": this.dockerImages.get('installer')
      },
      "startup": "./srcds_run -game garrysmod -console -usercon +hostname \"{{HOSTNAME}}\" +host_workshop_collection {{WORKSHOP_ID}} +gamemode {{GAMEMODE}} +map {{MAP}} +maxplayers {{MAX_PLAYERS}} -authkey {{STEAM_ACC}} -port {{SERVER_PORT}} +sv_setsteamaccount {{STEAM_ACC}}",
      "config": {
        "files": {},
        "startup": {
          "done": "gameserver Steam ID"
        },
        "stop": "quit",
        "logs": {
          "custom": false,
          "location": "logs/latest.log"
        }
      },
      "scripts": {
        "installation": {
          "script": "#!/bin/bash\ncd /mnt/server\n\napt update\napt install -y curl lib32gcc-s1\n\ncurl -sSL -o steamcmd.tar.gz https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz\ntar -xzvf steamcmd.tar.gz\nrm steamcmd.tar.gz\n\n./steamcmd.sh +force_install_dir /mnt/server +login anonymous +app_update 4020 validate +quit\n\necho \"Garry's Mod installation completed!\"",
          "container": this.dockerImages.get('installer'),
          "entrypoint": "bash"
        }
      },
      "variables": [
        {
          "name": "Hostname",
          "description": "The name of the server",
          "env_variable": "HOSTNAME",
          "default_value": "Pyro GMod Server",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:50",
          "field_type": "text"
        },
        {
          "name": "Workshop Collection ID",
          "description": "Steam Workshop Collection ID",
          "env_variable": "WORKSHOP_ID",
          "default_value": "",
          "user_viewable": true,
          "user_editable": true,
          "rules": "nullable|string",
          "field_type": "text"
        },
        {
          "name": "Gamemode",
          "description": "The gamemode to run",
          "env_variable": "GAMEMODE",
          "default_value": "sandbox",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:20",
          "field_type": "text"
        },
        {
          "name": "Map",
          "description": "The default map for the server",
          "env_variable": "MAP",
          "default_value": "gm_flatgrass",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|string|max:20",
          "field_type": "text"
        },
        {
          "name": "Steam Account Token",
          "description": "Steam Account Token for server registration",
          "env_variable": "STEAM_ACC",
          "default_value": "",
          "user_viewable": true,
          "user_editable": true,
          "rules": "nullable|string",
          "field_type": "text"
        },
        {
          "name": "Maximum Players",
          "description": "The maximum number of players",
          "env_variable": "MAX_PLAYERS",
          "default_value": "16",
          "user_viewable": true,
          "user_editable": true,
          "rules": "required|numeric|min:1|max:128",
          "field_type": "text"
        }
      ]
    };

    const eggs = [minecraftEgg, arkEgg, terrariaEgg, gmodEgg];
    
    for (const egg of eggs) {
      await this.saveEgg(egg);
      this.eggs.set(egg.uuid, egg);
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
      
      if (!this.eggs.has(config.eggId)) {
        console.error(`❌ Egg não encontrado: ${config.eggId}`);
        console.log(`📋 Eggs disponíveis:`, Array.from(this.eggs.keys()));
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

 async installServer(req, res) {
   const { id: serverId } = req.params;
   
   try {
     console.log(`📦 Iniciando instalação do servidor ${serverId}`);
     
     const config = await this.loadServerConfig(serverId);
     const egg = config.egg;
     
     this.io.to(serverId).emit('server-status', { status: 'installing' });
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: 'Iniciando instalação do servidor...'
     });
     
     const serverPath = this.getServerPath(serverId);
     
     // Executar script de instalação do egg
     if (egg.scripts && egg.scripts.installation) {
       await this.runInstallationScript(serverId, config);
     } else {
       // Instalação simples sem script
       this.io.to(serverId).emit('server-log', {
         timestamp: new Date().toISOString(),
         level: 'info',
         message: 'Configurando servidor...'
       });
       
       // Criar arquivos de configuração
       if (egg.config && egg.config.files) {
         await this.createEggFiles(serverId, config);
       }
     }
     
     // Marcar como instalado após delay
     setTimeout(() => {
       this.io.to(serverId).emit('server-status', { status: 'offline' });
       this.io.to(serverId).emit('server-log', {
         timestamp: new Date().toISOString(),
         level: 'info',
         message: 'Instalação concluída! Servidor pronto para uso.'
       });
     }, 10000);
     
     res.json({ success: true, message: 'Instalação iniciada' });
   } catch (error) {
     console.error(`❌ Erro na instalação do servidor ${serverId}:`, error);
     this.io.to(serverId).emit('server-status', { status: 'install_failed' });
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'error',
       message: `Erro na instalação: ${error.message}`
     });
     res.status(500).json({ error: 'Falha na instalação' });
   }
 }

 async runInstallationScript(serverId, config) {
   const egg = config.egg;
   const serverPath = this.getServerPath(serverId);
   
   this.io.to(serverId).emit('server-log', {
     timestamp: new Date().toISOString(),
     level: 'info',
     message: 'Executando script de instalação...'
   });
   
   // Preparar variáveis de ambiente para instalação
   const installEnv = [];
   
   if (egg.variables) {
     for (const variable of egg.variables) {
       const value = config.variables && config.variables[variable.env_variable] 
         ? config.variables[variable.env_variable] 
         : variable.default_value;
       
       installEnv.push(`${variable.env_variable}=${value}`);
     }
   }
   
   // Adicionar variáveis do sistema
   installEnv.push(`SERVER_PORT=${config.port}`);
   installEnv.push(`SERVER_MEMORY=${config.plan ? config.plan.ram * 1024 : 1024}`);
   
   const installContainer = egg.scripts.installation.container || this.dockerImages.get('installer');
   const installScript = egg.scripts.installation.script;
   const entrypoint = egg.scripts.installation.entrypoint || 'bash';
   
   try {
     // Criar script temporário
     const scriptPath = path.join(serverPath, 'install.sh');
     await fs.writeFile(scriptPath, installScript);
     await fs.chmod(scriptPath, '755');
     
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: 'Baixando imagem de instalação...'
     });
     
     // Pull da imagem de instalação se necessário
     try {
       await this.docker.getImage(installContainer).inspect();
     } catch {
       await this.docker.pull(installContainer);
     }
     
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: 'Executando instalação...'
     });
     
     // Executar container de instalação
     const installContainerConfig = {
       Image: installContainer,
       Env: installEnv,
       WorkingDir: '/mnt/server',
       HostConfig: {
         Binds: [`${serverPath}:/mnt/server`],
         AutoRemove: true,
         Memory: 2 * 1024 * 1024 * 1024, // 2GB para instalação
         NetworkMode: 'bridge'
       },
       Cmd: [entrypoint, '/mnt/server/install.sh']
     };
     
     const container = await this.docker.createContainer(installContainerConfig);
     
     // Capturar logs da instalação
     const stream = await container.logs({
       follow: true,
       stdout: true,
       stderr: true,
       timestamps: true
     });
     
     stream.on('data', (chunk) => {
       const log = chunk.toString('utf8').trim();
       if (log) {
         this.io.to(serverId).emit('server-log', {
           timestamp: new Date().toISOString(),
           level: 'info',
           message: this.cleanLogMessage(log)
         });
       }
     });
     
     await container.start();
     const result = await container.wait();
     
     // Remover script de instalação
     await fs.unlink(scriptPath);
     
     if (result.StatusCode === 0) {
       this.io.to(serverId).emit('server-log', {
         timestamp: new Date().toISOString(),
         level: 'info',
         message: 'Script de instalação executado com sucesso!'
       });
     } else {
       throw new Error(`Installation script failed with code ${result.StatusCode}`);
     }
     
   } catch (error) {
     console.error(`❌ Erro no script de instalação:`, error);
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'error',
       message: `Erro na instalação: ${error.message}`
     });
     throw error;
   }
 }

 async createEggFiles(serverId, config) {
   const serverPath = this.getServerPath(serverId);
   const egg = config.egg;
   
   if (!egg.config || !egg.config.files) return;
   
   for (const [fileName, fileConfig] of Object.entries(egg.config.files)) {
     const filePath = path.join(serverPath, fileName);
     
     try {
       if (fileConfig.parser === 'properties') {
         // Criar arquivo de propriedades
         let content = '';
         for (const [key, value] of Object.entries(fileConfig.find || {})) {
           const processedValue = this.processVariables(value, config);
           content += `${key}=${processedValue}\n`;
         }
         
         await fs.mkdir(path.dirname(filePath), { recursive: true });
         await fs.writeFile(filePath, content);
         console.log(`📁 Arquivo criado: ${fileName}`);
         
       } else if (fileConfig.parser === 'file') {
         // Criar arquivo simples
         let content = '';
         if (typeof fileConfig.find === 'string') {
           content = this.processVariables(fileConfig.find, config);
         } else if (typeof fileConfig.find === 'object') {
           for (const [key, value] of Object.entries(fileConfig.find)) {
             const processedValue = this.processVariables(value, config);
             content += `${key}=${processedValue}\n`;
           }
         }
         
         await fs.mkdir(path.dirname(filePath), { recursive: true });
         await fs.writeFile(filePath, content);
         console.log(`📁 Arquivo criado: ${fileName}`);
         
       } else if (fileConfig.parser === 'yaml' || fileConfig.parser === 'yml') {
         // Para arquivos YAML
         let content = '';
         for (const [key, value] of Object.entries(fileConfig.find || {})) {
           const processedValue = this.processVariables(value, config);
           content += `${key}: ${processedValue}\n`;
         }
         
         await fs.mkdir(path.dirname(filePath), { recursive: true });
         await fs.writeFile(filePath, content);
         console.log(`📁 Arquivo YAML criado: ${fileName}`);
       }
     } catch (error) {
       console.error(`❌ Erro ao criar arquivo ${fileName}:`, error);
     }
   }
 }

 processVariables(template, config) {
   if (typeof template !== 'string') return template;
   
   let result = template;
   
   // Processar variáveis do egg
   if (config.egg && config.egg.variables) {
     for (const variable of config.egg.variables) {
       const placeholder = `{{server.build.env.${variable.env_variable}}}`;
       const value = config.variables && config.variables[variable.env_variable] 
         ? config.variables[variable.env_variable] 
         : variable.default_value;
       
       result = result.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), value);
     }
   }
   
   // Variáveis do sistema
   result = result.replace(/{{server\.build\.default\.port}}/g, config.port || '25565');
   result = result.replace(/{{SERVER_MEMORY}}/g, (config.plan ? config.plan.ram * 1024 : 1024).toString());
   result = result.replace(/{{SERVER_JARFILE}}/g, config.variables?.SERVER_JARFILE || 'server.jar');
   
   // Variáveis diretas (sem server.build.env)
   if (config.variables) {
     for (const [key, value] of Object.entries(config.variables)) {
       result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
     }
   }
   
   return result;
 }

 async createContainer(serverId, config) {
   const egg = config.egg;
   const serverPath = this.getServerPath(serverId);
   
   console.log(`🐳 Criando container ${serverId} com egg ${egg.name}`);
   
   // Determinar imagem Docker
   let dockerImage = this.dockerImages.get('java_17'); // Default
   
   if (egg.docker_images) {
     const images = Object.values(egg.docker_images);
     if (images.length > 0) {
       // Priorizar Java 17 se disponível, senão usar a primeira
       if (egg.docker_images["Java 17"]) {
         dockerImage = egg.docker_images["Java 17"];
       } else if (egg.docker_images["Java 21"]) {
         dockerImage = egg.docker_images["Java 21"];
       } else {
         dockerImage = images[0];
       }
     }
   }
   
   console.log(`🐳 Usando imagem: ${dockerImage}`);
   
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
   
   // Adicionar variáveis padrão do sistema
   environment.push(`SERVER_PORT=${config.port}`);
   environment.push(`SERVER_MEMORY=${config.plan ? config.plan.ram * 1024 : 1024}`);
   environment.push(`P_SERVER_LOCATION=${config.location}`);
   environment.push(`P_SERVER_UUID=${serverId}`);
   environment.push(`STARTUP=${egg.startup}`);
   
   // Processar comando de startup
   let startupCommand = egg.startup || 'echo "No startup command defined"';
   startupCommand = this.processVariables(startupCommand, config);
   
   // Determinar portas a expor
   const exposedPorts = {};
   const portBindings = {};
   
   // Porta principal
   exposedPorts[`${config.port}/tcp`] = {};
   exposedPorts[`${config.port}/udp`] = {};
   portBindings[`${config.port}/tcp`] = [{ HostPort: config.port.toString() }];
   portBindings[`${config.port}/udp`] = [{ HostPort: config.port.toString() }];
   
   // Portas adicionais para alguns jogos
   if (egg.name.toLowerCase().includes('minecraft')) {
     // RCON port
     const rconPort = parseInt(config.port) + 1000;
     exposedPorts[`${rconPort}/tcp`] = {};
     portBindings[`${rconPort}/tcp`] = [{ HostPort: rconPort.toString() }];
   }
   
   const containerConfig = {
     Image: dockerImage,
     name: `pyro-server-${serverId}`,
     Env: environment,
     ExposedPorts: exposedPorts,
     HostConfig: {
       PortBindings: portBindings,
       Memory: config.plan ? config.plan.ram * 1024 * 1024 * 1024 : 2 * 1024 * 1024 * 1024,
       CpuShares: config.plan ? config.plan.cpu * 1024 : 1024,
       Binds: [
         `${serverPath}:/home/container`
       ],
       RestartPolicy: {
         Name: 'unless-stopped'
       },
       NetworkMode: 'bridge',
       ReadonlyRootfs: false,
       CapDrop: ['ALL'],
       CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
       SecurityOpt: ['no-new-privileges:true']
     },
     WorkingDir: '/home/container',
     AttachStdout: true,
     AttachStderr: true,
     Tty: true,
     User: 'container',
     Cmd: ['/bin/bash', '-c', `cd /home/container && ${startupCommand}`]
   };

   // Verificar se a imagem existe
   try {
     await this.docker.getImage(dockerImage).inspect();
     console.log(`✅ Imagem ${dockerImage} já existe`);
   } catch (error) {
     console.log(`📥 Fazendo pull da imagem ${dockerImage}...`);
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'info',
       message: `Baixando imagem Docker: ${dockerImage}`
     });
     
     try {
       await this.docker.pull(dockerImage);
       console.log(`✅ Pull da imagem ${dockerImage} concluído`);
     } catch (pullError) {
       console.error(`❌ Erro no pull da imagem ${dockerImage}:`, pullError);
       throw new Error(`Failed to pull Docker image: ${dockerImage}`);
     }
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
     
     // Aguardar um pouco antes de marcar como online
     setTimeout(() => {
       this.io.to(serverId).emit('server-status', { status: 'online' });
       this.io.to(serverId).emit('server-log', {
         timestamp: new Date().toISOString(),
         level: 'info',
         message: 'Servidor online!'
       });
     }, 15000);

     console.log(`✅ Servidor ${serverId} iniciado com sucesso`);
     res.json({ success: true, status: 'starting' });
   } catch (error) {
     console.error(`❌ Erro ao iniciar servidor ${serverId}:`, error);
     this.io.to(serverId).emit('server-status', { status: 'error' });
     this.io.to(serverId).emit('server-log', {
       timestamp: new Date().toISOString(),
       level: 'error',
       message: `Erro ao iniciar: ${error.message}`
     });
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
       try {
         await this.executeCommandInContainer(container, egg.config.stop);
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
     if (this.containers.has(serverId)) {
       await this.stopServer(req, { json: () => {} });
       await new Promise(resolve => setTimeout(resolve, 3000));
     }
     
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
         
         this.io.to(serverId).emit('server-log', logData);
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
     
     await this.executeCommandInContainer(container, command);
     
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

 async executeCommandInContainer(container, command) {
   const exec = await container.exec({
     Cmd: ['sh', '-c', `echo "${command}" > /proc/1/fd/0`],
     AttachStdout: true,
     AttachStderr: true,
     Tty: true
   });

   await exec.start({ Tty: true });
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
   }, 5000);
 }

 processContainerStats(stats) {
   try {
     const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
     const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats?.system_cpu_usage || 0);
     const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * (stats.cpu_stats.online_cpus || 1) * 100 : 0;

     const memoryUsage = stats.memory_stats.usage || 0;
     const memoryLimit = stats.memory_stats.limit || 1;
     const memoryPercent = (memoryUsage / memoryLimit) * 100;

     const networks = stats.networks || {};
     const networkKeys = Object.keys(networks);
     const networkData = networkKeys.length > 0 ? networks[networkKeys[0]] : { rx_bytes: 0, tx_bytes: 0 };

     return {
       cpu: Math.min(Math.round(cpuPercent || 0), 100),
       memory: {
         used: Math.round(memoryUsage / 1024 / 1024),
         total: Math.round(memoryLimit / 1024 / 1024),
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
     
     if (!fullPath.startsWith(serverPath)) {
       return res.status(400).json({ error: 'Caminho inválido' });
     }
     
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

 setupCleanupTasks() {
   // Verificação de status dos containers (executa a cada minuto)
   setInterval(async () => {
     await this.checkContainerStatus();
   }, 60000);

   // Limpeza de logs antigos (executa diariamente)
   setInterval(async () => {
     await this.cleanupOldLogs();
   }, 24 * 60 * 60 * 1000);

   console.log('✅ Tarefas de limpeza configuradas');
 }

 async checkContainerStatus() {
   try {
     for (const [serverId, container] of this.containers.entries()) {
       try {
         const containerInfo = await container.inspect();
         
         if (!containerInfo.State.Running) {
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
         this.containers.delete(serverId);
         this.serverStats.delete(serverId);
         
         this.io.to(serverId).emit('server-status', { status: 'offline' });
       }
     }
   } catch (error) {
     // Erro silencioso para não poluir logs
   }
 }

 async cleanupOldLogs() {
   try {
     const logsDir = path.join(__dirname, 'logs');
     const servers = await fs.readdir(logsDir);
     
     for (const serverId of servers) {
       const serverLogsDir = path.join(logsDir, serverId);
       const logFiles = await fs.readdir(serverLogsDir);
       
       for (const logFile of logFiles) {
         const logPath = path.join(serverLogsDir, logFile);
         const stats = await fs.stat(logPath);
         
         // Remover logs com mais de 30 dias
         const thirtyDaysAgo = new Date();
         thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
         
         if (stats.mtime < thirtyDaysAgo) {
           await fs.unlink(logPath);
           console.log(`🧹 Log antigo removido: ${logPath}`);
         }
       }
     }
   } catch (error) {
     console.error('❌ Erro na limpeza de logs:', error);
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

 // Método para listar eggs disponíveis
 async getAvailableEggs(req, res) {
   try {
     const eggs = Array.from(this.eggs.values()).map(egg => ({
       uuid: egg.uuid,
       name: egg.name,
       description: egg.description,
       author: egg.author,
       docker_images: Object.keys(egg.docker_images || {}),
       variables: egg.variables?.map(v => ({
         name: v.name,
         env_variable: v.env_variable,
         default_value: v.default_value,
         user_viewable: v.user_viewable,
         user_editable: v.user_editable,
         rules: v.rules,
         field_type: v.field_type
       })) || []
     }));
     
     res.json({ eggs });
   } catch (error) {
     console.error('❌ Erro ao listar eggs:', error);
     res.status(500).json({ error: 'Erro ao carregar eggs' });
   }
 }

 // Método para obter informações de um egg específico
 async getEggInfo(req, res) {
   const { eggId } = req.params;
   
   try {
     const egg = this.eggs.get(eggId);
     if (!egg) {
       return res.status(404).json({ error: 'Egg não encontrado' });
     }
     
     res.json({ egg });
   } catch (error) {
     console.error(`❌ Erro ao obter egg ${eggId}:`, error);
     res.status(500).json({ error: 'Erro ao carregar egg' });
   }
 }

 // Método para validar configuração de servidor
 validateServerConfig(config) {
   const errors = [];
   
   if (!config.eggId) {
     errors.push('EggId é obrigatório');
   }
   
   if (!config.port || config.port < 1024 || config.port > 65535) {
     errors.push('Porta deve estar entre 1024 e 65535');
   }
   
   if (!config.plan || !config.plan.ram || !config.plan.cpu || !config.plan.disk) {
     errors.push('Configuração do plano é obrigatória');
   }
   
   const egg = this.eggs.get(config.eggId);
   if (egg && egg.variables) {
     for (const variable of egg.variables) {
       if (variable.rules && variable.rules.includes('required')) {
         const value = config.variables?.[variable.env_variable];
         if (!value && !variable.default_value) {
           errors.push(`Variável ${variable.name} é obrigatória`);
         }
       }
     }
   }
   
   return errors;
 }

 // Método para testar conectividade de rede do node
 async testNetworkConnectivity(req, res) {
   try {
     const testContainer = await this.docker.createContainer({
       Image: this.dockerImages.get('alpine') || 'alpine:latest',
       Cmd: ['ping', '-c', '3', '8.8.8.8'],
       HostConfig: {
         AutoRemove: true,
         NetworkMode: 'bridge'
       }
     });
     
     await testContainer.start();
     const result = await testContainer.wait();
     
     res.json({ 
       success: result.StatusCode === 0,
       message: result.StatusCode === 0 ? 'Conectividade OK' : 'Falha na conectividade'
     });
   } catch (error) {
     console.error('❌ Erro no teste de conectividade:', error);
     res.status(500).json({ error: 'Erro no teste de conectividade' });
   }
 }

 // Método para obter informações do Docker
 async getDockerInfo(req, res) {
   try {
     const info = await this.docker.info();
     const version = await this.docker.version();
     
     res.json({
       docker_version: version.Version,
       containers: info.Containers,
       images: info.Images,
       memory: info.MemTotal,
       cpus: info.NCPU,
       storage_driver: info.Driver,
       kernel_version: info.KernelVersion,
       operating_system: info.OperatingSystem,
       architecture: info.Architecture
     });
   } catch (error) {
     console.error('❌ Erro ao obter informações do Docker:', error);
     res.status(500).json({ error: 'Erro ao obter informações do Docker' });
   }
 }

 start(port = 8080) {
   this.server.listen(port, () => {
     console.log(`🔥 Wings Daemon rodando na porta ${port}`);
     console.log(`📝 Endpoints disponíveis:`);
     console.log(`   - GET  /health - Status do daemon`);
     console.log(`   - POST /api/servers/:id/config - Criar configuração`);
     console.log(`   - GET  /api/servers/:id/config - Obter configuração`);
     console.log(`   - POST /api/servers/:id/start - Iniciar servidor`);
     console.log(`   - POST /api/servers/:id/stop - Parar servidor`);
     console.log(`   - POST /api/servers/:id/restart - Reiniciar servidor`);
     console.log(`   - POST /api/servers/:id/kill - Forçar parada`);
     console.log(`   - POST /api/servers/:id/install - Instalar servidor`);
     console.log(`   - POST /api/servers/:id/reinstall - Reinstalar servidor`);
     console.log(`   - GET  /api/servers/:id/stats - Estatísticas do servidor`);
     console.log(`   - GET  /api/servers/:id/logs - Logs do servidor`);
     console.log(`   - POST /api/servers/:id/command - Enviar comando`);
     console.log(`   - GET  /api/servers/:id/files - Gerenciar arquivos`);
     console.log(`   - POST /api/servers/:id/files - Upload de arquivo`);
     console.log(`   - PUT  /api/servers/:id/files - Atualizar arquivo`);
     console.log(`   - DELETE /api/servers/:id/files - Deletar arquivo`);
     console.log(`   - GET  /api/eggs - Listar eggs disponíveis`);
     console.log(`   - GET  /api/eggs/:eggId - Informações do egg`);
     console.log(`   - GET  /api/system/docker - Informações do Docker`);
     console.log(`   - GET  /api/system/network - Teste de conectividade`);
     console.log(`🌐 WebSocket disponível para comunicação em tempo real`);
     console.log(`🥚 ${this.eggs.size} eggs carregados`);
     console.log(`🐳 ${this.dockerImages.size} imagens Docker configuradas`);
   });
   
   // Adicionar as novas rotas
   this.app.get('/api/eggs', this.getAvailableEggs.bind(this));
   this.app.get('/api/eggs/:eggId', this.getEggInfo.bind(this));
   this.app.get('/api/system/docker', this.getDockerInfo.bind(this));
   this.app.get('/api/system/network', this.testNetworkConnectivity.bind(this));
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

process.on('uncaughtException', (error) => {
 console.error('❌ Erro não capturado:', error);
 process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
 console.error('❌ Promise rejeitada não tratada:', reason);
});

module.exports = WingsDaemon;