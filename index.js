const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
require('dotenv').config(); // Load biến môi trường từ .env

// Lấy giá trị từ biến môi trường
const TOKEN = process.env.TOKEN;
const TEMP_CHANNEL_ID = process.env.TEMP_CHANNEL_ID;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates, // Intent để theo dõi trạng thái kênh thoại
        GatewayIntentBits.GuildMessages,   // Intent để theo dõi tin nhắn trong server
        GatewayIntentBits.MessageContent   // Intent để đọc nội dung tin nhắn
    ]
});

client.on('ready', () => {
    console.log(`Bot is ready to connect : ${client.user.tag}`);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    const tempChannel = newState.guild.channels.cache.get(TEMP_CHANNEL_ID);

    if (newState.channelId === TEMP_CHANNEL_ID) {
        const user = newState.member;
        const channelName = `${user.user.username}'s Room`;

        const newChannel = await newState.guild.channels.create({
            name: channelName,
            type: 2, 
            parent: tempChannel.parentId,
            permissionOverwrites: [
                {
                    id: user.id,
                    allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak, PermissionsBitField.Flags.ManageRoles], // Sử dụng PermissionsBitField.Flags
                },
                {
                    id: newState.guild.id,
                    allow: [PermissionsBitField.Flags.Connect], // Sử dụng PermissionsBitField.Flags
                },
            ],
        });

        await user.voice.setChannel(newChannel);
    }

    if (oldState.channel && oldState.channel.id !== TEMP_CHANNEL_ID && oldState.channel.members.size === 0) {
        if (oldState.channel.name.includes("'s Room")) {
            oldState.channel.delete();
        }
    }
});


client.login(TOKEN);
