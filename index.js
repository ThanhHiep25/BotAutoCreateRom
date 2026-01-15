const { 
    Client, GatewayIntentBits, PermissionsBitField, ChannelType, ActivityType, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, 
    TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, 
    UserSelectMenuBuilder, EmbedBuilder, ComponentType 
} = require('discord.js');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const express = require('express');
const app = express();
const fs = require('fs');
require('dotenv').config();

// --- CONFIG ---
const TOKEN = process.env.TOKEN;
const TEMP_CHANNEL_ID = process.env.TEMP_CHANNEL_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; 

if (!TOKEN || !TEMP_CHANNEL_ID || !GEMINI_API_KEY) {
    console.error("❌ Lỗi: Thiếu thông tin trong file .env");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" }); // Dùng 1.5-flash ổn định nhất hiện tại

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences
    ]
});

// --- CẤU HÌNH LOGGING ---
const LOG_LEVELS = {
    SUCCESS: { color: 0x2ECC71, icon: '✅', title: 'Thành Công' },
    UPDATE:  { color: 0x3498DB, icon: '📝', title: 'Cập Nhật' }, 
    WARNING: { color: 0xF1C40F, icon: '🔒', title: 'Bảo Mật' },
    DANGER:  { color: 0xE74C3C, icon: '⛔', title: 'Nguy Hiểm' },
    MOD:     { color: 0x9B59B6, icon: '🛡️', title: 'Auto-Mod' },
    GAME:    { color: 0xE67E22, icon: '🎲', title: 'Giải Trí' },
    CHAOS:   { color: 0xFF0000, icon: '🔥', title: 'Hỗn Loạn' },
    INFO:    { color: 0x95A5A6, icon: 'ℹ️', title: 'Thông Tin' }
};

async function sendSystemLog(guild, level, action, description, user = null) {
    if (!LOG_CHANNEL_ID) return;
    try {
        const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
        if (!logChannel) return;
        const config = LOG_LEVELS[level] || LOG_LEVELS.INFO;
        const embed = new EmbedBuilder().setColor(config.color).setTitle(`${config.icon} ${action}`).setDescription(description).setTimestamp().setFooter({ text: `System Log • ${config.title}` });
        if (user) { embed.setAuthor({ name: user.username, iconURL: user.displayAvatarURL() }); embed.addFields({ name: 'Người thực hiện', value: `<@${user.id}>`, inline: true }); }
        logChannel.send({ embeds: [embed] }).catch(() => {});
    } catch (e) { console.error("Lỗi gửi log:", e); }
}

// --- CẤU HÌNH AUTO-MOD ---
const BAD_WORDS = ['dm', 'dkm', 'cc', 'cl', 'ngu', 'óc chó', 'fck', 'shjt']; 
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'mp3', 'pdf', 'doc', 'docx', 'txt', 'xlsx', 'pptx'];

// --- BIẾN HỆ THỐNG ---
const creatingUsers = new Set(); 
const voiceSessions = new Map();
const ghostModeChannels = new Set();
const sleepTimers = new Map();
const muteAllStates = new Map(); 

// --- DATABASE 1: VOICE TIME ---
const VOICE_DB_FILE = './voiceData.json';
function loadVoiceData() { try { if (!fs.existsSync(VOICE_DB_FILE)) fs.writeFileSync(VOICE_DB_FILE, JSON.stringify({})); return JSON.parse(fs.readFileSync(VOICE_DB_FILE, 'utf8')); } catch (e) { return {}; } }
function saveVoiceData(data) { fs.writeFileSync(VOICE_DB_FILE, JSON.stringify(data, null, 2)); }
function addVoiceTime(userId, durationMs) { const data = loadVoiceData(); if (!data[userId]) data[userId] = { totalTime: 0, lastSeen: Date.now() }; data[userId].totalTime += durationMs; data[userId].lastSeen = Date.now(); saveVoiceData(data); }

// --- DATABASE 2: SETTINGS ---
const SETTINGS_DB_FILE = './userSettings.json';
function loadSettings() { try { if (!fs.existsSync(SETTINGS_DB_FILE)) fs.writeFileSync(SETTINGS_DB_FILE, JSON.stringify({})); return JSON.parse(fs.readFileSync(SETTINGS_DB_FILE, 'utf8')); } catch (e) { return {}; } }
function saveSettings(userId, name, limit) { const data = loadSettings(); data[userId] = { name: name, limit: limit }; fs.writeFileSync(SETTINGS_DB_FILE, JSON.stringify(data, null, 2)); }
function deleteSettings(userId) { const data = loadSettings(); delete data[userId]; fs.writeFileSync(SETTINGS_DB_FILE, JSON.stringify(data, null, 2)); }

function formatTime(ms) { const seconds = Math.floor((ms / 1000) % 60); const minutes = Math.floor((ms / (1000 * 60)) % 60); const hours = Math.floor((ms / (1000 * 60 * 60))); return `${hours}h ${minutes}m ${seconds}s`; }

// --- AI HELPERS ---
async function getCreativeChannelName(username, activityName) { try { let prompt = `User "${username}" tạo phòng voice. ${activityName ? `Đang chơi "${activityName}".` : ""} Đặt 1 tên phòng ngắn (dưới 5 từ), ngầu/hài. Chỉ trả về tên.`; const result = await model.generateContent(prompt); return result.response.text().replace(/['"]+/g, '').trim(); } catch (e) { return `${username}'s Room`; } }
async function getAiWelcomeMessage(activityName) { try { const prompt = `User chơi "${activityName || "trò chuyện"}". Viết 1 câu chào mừng ngắn, thân thiện + 1 mẹo nhỏ/câu đùa.`; const result = await model.generateContent(prompt); return result.response.text().trim(); } catch (e) { return "Chào mừng mọi người!"; } }
async function getAiGreetingForGuest(guestName, activityName) { try { const prompt = `User "${guestName}" vừa vào phòng. ${activityName ? `Họ đang chơi "${activityName}".` : ""} Hãy chào họ 1 câu ngắn, hài hước kiểu game thủ.`; const result = await model.generateContent(prompt); return result.response.text().trim(); } catch (e) { return `Chào ${guestName}, quẩy lên nào!`; } }


// --- HÀM TẠO PANEL TỐI ƯU (ĐÃ SẮP XẾP LẠI THÀNH 5 HÀNG) ---
// Discord chỉ cho phép tối đa 5 ActionRow. Mình phải gộp các nút lại.
function createControlPanel() {
    // Hàng 1: Quản lý cơ bản
    const r1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_lock').setLabel('Khóa Phòng').setEmoji('🔒').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_unlock').setLabel('Mở Khóa').setEmoji('🔓').setStyle(ButtonStyle.Secondary), 
        new ButtonBuilder().setCustomId('btn_rename').setLabel('Đổi Tên Phòng').setEmoji('✍️').setStyle(ButtonStyle.Secondary), 
        new ButtonBuilder().setCustomId('btn_limit').setLabel('Slot').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_ghost_mode').setLabel('Chế Độ Ma(10s tự xóa tin nhắn)').setEmoji('👻').setStyle(ButtonStyle.Secondary)
    );

    // Hàng 2: Cài đặt & Kick
    const r2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_bitrate').setLabel('Audio').setEmoji('🎧').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_toggle_chat').setLabel('Chat').setEmoji('💬').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_kick_menu').setLabel('Kick').setEmoji('👈').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('btn_trust').setLabel('Trust').setEmoji('🛡️').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_block').setLabel('Block').setEmoji('⛔').setStyle(ButtonStyle.Danger)
    );

    // Hàng 3: Menu Modes (Giữ nguyên)
    const r3 = new StringSelectMenuBuilder()
        .setCustomId('select_mode')
        .setPlaceholder('⚡ Chọn chế độ nhanh / Hẹn giờ...')
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel('Gaming Mode').setEmoji('🎮').setValue('mode_gaming'),
            new StringSelectMenuOptionBuilder().setLabel('Private Mode').setEmoji('🤫').setValue('mode_private'),
            new StringSelectMenuOptionBuilder().setLabel('Timer: 1m').setEmoji('⏲️').setValue('timer_1'),
            new StringSelectMenuOptionBuilder().setLabel('Timer: 5m').setEmoji('⏲️').setValue('timer_5'),
            new StringSelectMenuOptionBuilder().setLabel('Timer: 10m').setEmoji('⏱️').setValue('timer_10'),
            new StringSelectMenuOptionBuilder().setLabel('Timer: 15m').setEmoji('⏰').setValue('timer_15'),
            new StringSelectMenuOptionBuilder().setLabel('Timer: 20m').setEmoji('⏱️').setValue('timer_20'),
            new StringSelectMenuOptionBuilder().setLabel('Timer: 30m').setEmoji('⏱️').setValue('timer_30'),
            new StringSelectMenuOptionBuilder().setLabel('Timer: 1h').setEmoji('⏰').setValue('timer_60'),
            new StringSelectMenuOptionBuilder().setLabel('Hủy Timer').setEmoji('❌').setValue('timer_off'),
        );
    const row3 = new ActionRowBuilder().addComponents(r3);

    // Hàng 4: Thống kê & Save
    const r5 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_stats').setLabel('Thống Kê Time').setEmoji('⌚').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_leaderboard').setLabel('Bảng Xếp Hạng').setEmoji('🥇').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_save_config').setLabel('Lưu Config').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('btn_reset_config').setLabel('Xóa Config').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('btn_claim').setLabel('Chiếm Quyền').setStyle(ButtonStyle.Primary)
    );

    // Hàng 5: Fun & Chaos Tools (Gộp lại cho đủ chỗ)
    const r4 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('btn_mute_all').setLabel('Tắt Mic Tất Cả').setEmoji('🔇').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_summon').setLabel('Triệu Hồi').setEmoji('📣').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_nuke').setLabel('Hủy Diệt').setEmoji('☢️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_roulette').setLabel('Xoay Súng').setEmoji('🔫').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('btn_dice').setLabel('Xúc Xắc').setEmoji('🎲').setStyle(ButtonStyle.Success)
    );

    // Trả về đúng 5 hàng
    return [r1, r2, row3, r4, r5];
}

// --- READY ---
client.on('ready', () => {
    console.log(`✅ Bot Online: ${client.user.tag}`);
});

// --- SỰ KỆN: AUTO-MOD + GHOST MODE + AI CHAT ---
client.on('messageCreate', async message => {
    if (message.author.bot || !message.channel.topic) return; 
    const voiceChannel = message.guild.channels.cache.get(message.channel.topic);
    if (!voiceChannel) return; 

    if (ghostModeChannels.has(voiceChannel.id)) setTimeout(() => { message.delete().catch(() => {}); }, 10000); 

    const isOwner = voiceChannel.permissionsFor(message.author)?.has(PermissionsBitField.Flags.ManageChannels);

    // AUTO-MOD
    if (!isOwner) { 
        const content = message.content.toLowerCase();
        if (BAD_WORDS.some(word => content.includes(word))) {
            await message.delete().catch(()=>{});
            sendSystemLog(message.guild, "MOD", "Ngôn từ vi phạm", `User: <@${message.author.id}>\nPhòng: **${voiceChannel.name}**`, message.author);
            const w = await message.channel.send(`🚫 <@${message.author.id}>, giữ mồm giữ miệng!`); setTimeout(()=>w.delete(), 5000);
            return;
        }
        if (message.attachments.size > 0) {
            const invalid = message.attachments.find(att => !ALLOWED_EXTENSIONS.includes(att.name.split('.').pop().toLowerCase()));
            if (invalid) {
                await message.delete().catch(()=>{});
                sendSystemLog(message.guild, "MOD", "File cấm", `User: <@${message.author.id}>\nPhòng: **${voiceChannel.name}**`, message.author);
                const w = await message.channel.send(`🚫 <@${message.author.id}>, file cấm!`); setTimeout(()=>w.delete(), 5000);
                return;
            }
        }
    }

    // AI CHAT
    if (message.mentions.has(client.user) || message.content.startsWith('?')) {
        await message.channel.sendTyping();
        try {
            let query = message.content.replace(/<@!?[0-9]+>/, '').replace(/^\?/, '').trim();
            if (!query) return message.reply("👀 Bạn muốn hỏi gì tui?");
            
            const prompt = `Bạn là một trợ lý Discord Bot vui tính, hơi "lầy lội" và đam mê game. Người dùng "${message.author.username}" đang hỏi: "${query}". Hãy trả lời ngắn gọn, hài hước.`;
            const result = await model.generateContent(prompt);
            await message.reply(result.response.text());
            sendSystemLog(message.guild, "INFO", "Dùng AI", `User: ${message.author.username}\nHỏi: ${query}`, null);
        } catch (e) { console.error("Lỗi AI Chat:", e); message.reply("😵‍💫 Lag não rồi (Lỗi API), hỏi lại sau nha!"); }
    }
});

// --- VOICE STATE ---
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.channelId && !oldState.member.user.bot) {
        const startTime = voiceSessions.get(oldState.id);
        if (startTime) {
            const duration = Date.now() - startTime;
            if (duration > 5000) addVoiceTime(oldState.id, duration);
            voiceSessions.delete(oldState.id);
        }
    }
    if (newState.channelId && !newState.member.user.bot) voiceSessions.set(newState.id, Date.now());

    // TẠO PHÒNG MỚI
    if (newState.channelId === TEMP_CHANNEL_ID) {
        const user = newState.member;
        if (creatingUsers.has(user.id)) return;
        creatingUsers.add(user.id);
        setTimeout(() => creatingUsers.delete(user.id), 5000);

        const parentChannel = newState.guild.channels.cache.get(TEMP_CHANNEL_ID);
        if (!parentChannel) return;

        try {
            const existing = newState.guild.channels.cache.find(c => c.parentId === parentChannel.parentId && c.type === ChannelType.GuildVoice && c.permissionOverwrites.cache.has(user.id) && c.id !== TEMP_CHANNEL_ID);
            if (existing) { await user.voice.setChannel(existing).catch(()=>{}); return; }

            const settings = loadSettings();
            const userSetting = settings[user.id];
            const roomName = userSetting ? userSetting.name : `Waiting...`;
            const roomLimit = userSetting ? userSetting.limit : 0;

            const voiceChannel = await newState.guild.channels.create({
                name: roomName,
                type: ChannelType.GuildVoice,
                parent: parentChannel.parentId,
                userLimit: roomLimit,
                permissionOverwrites: [{ id: user.id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ManageChannels] }, { id: newState.guild.id, allow: [PermissionsBitField.Flags.Connect] }],
            });

            sendSystemLog(newState.guild, "SUCCESS", "Tạo Phòng", `User: <@${user.id}>\nPhòng: **${roomName}**`, user.user);

            const textChannel = await newState.guild.channels.create({
                name: `chat・${user.user.username}`,
                type: ChannelType.GuildText,
                parent: parentChannel.parentId,
                topic: voiceChannel.id, 
                permissionOverwrites: [{ id: newState.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }, { id: user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }, { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }],
            });

            if (user.voice.channelId) {
                await user.voice.setChannel(voiceChannel).catch(async () => { await voiceChannel.delete(); await textChannel.delete(); });
            } else { await voiceChannel.delete(); await textChannel.delete(); return; }

            const activity = user.presence?.activities.find(a => a.type === ActivityType.Playing);
            const activityName = activity ? activity.name : null;

            const sendWelcome = async (name, advice) => {
                const embed = new EmbedBuilder()
                    .setColor(0x0099FF)
                    .setTitle(`✨ Phòng của ${user.user.username}`)
                    .setDescription(`**${advice}**`)
                    .addFields({ name: 'Thông tin', value: `Tên: **${name}**\nSlot: **${roomLimit===0?'Vô cực':roomLimit}**`, inline: true })
                    .setThumbnail(user.user.displayAvatarURL({ dynamic: true }))
                    .setFooter({ text: 'Gemini Room Manager' });

                if (newState.guild.channels.cache.has(voiceChannel.id)) {
                    await voiceChannel.setName(name).catch(()=>{});
                    // ĐÃ SỬA: Gọi đúng tên hàm createControlPanel()
                    await textChannel.send({ content: `<@${user.id}>`, embeds: [embed], components: createControlPanel() }).catch((e) => console.log("Lỗi gửi Panel:", e));
                }
            };

            if (userSetting) {
                const advice = await getAiWelcomeMessage(activityName);
                await sendWelcome(roomName, advice);
            } else {
                Promise.all([getCreativeChannelName(user.user.username, activityName), getAiWelcomeMessage(activityName)])
                .then(async ([n, a]) => await sendWelcome(n, a)).catch(()=>{});
            }
        } catch (e) { creatingUsers.delete(user.id); }
    }

    // NGƯỜI VÀO PHÒNG
    if (newState.channelId && newState.channelId !== TEMP_CHANNEL_ID) {
        const linkedText = newState.guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.topic === newState.channelId);
        if (linkedText) {
            const isLocked = !linkedText.permissionsFor(newState.guild.id).has(PermissionsBitField.Flags.SendMessages);
            await linkedText.permissionOverwrites.create(newState.member.id, { ViewChannel: true, SendMessages: !isLocked, AttachFiles: !isLocked }).catch(()=>{});
            
            const isMutedAll = muteAllStates.get(newState.channelId);
            if (isMutedAll) await newState.member.voice.setMute(true).catch(()=>{});

            if (oldState.channelId !== newState.channelId) {
                const act = newState.member.presence?.activities.find(a => a.type === ActivityType.Playing);
                getAiGreetingForGuest(newState.member.user.username, act ? act.name : null).then(msg => {
                    linkedText.send({ embeds: [new EmbedBuilder().setColor(0x00FF00).setDescription(`👋 **${newState.member.user.username}** vào phòng!\n*${msg}*`)] }).catch(()=>{});
                });
            }
        }
    }

    // NGƯỜI RỜI PHÒNG (XÓA PHÒNG NẾU TRỐNG)
    if (oldState.channelId && oldState.channelId !== TEMP_CHANNEL_ID) {
        const linkedText = oldState.guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.topic === oldState.channelId);
        const oldVoice = oldState.guild.channels.cache.get(oldState.channelId);
        if (oldVoice) {
            if (oldVoice.members.size === 0) {
                ghostModeChannels.delete(oldState.channelId);
                muteAllStates.delete(oldState.channelId);
                if (sleepTimers.has(oldState.channelId)) {
                    clearTimeout(sleepTimers.get(oldState.channelId));
                    sleepTimers.delete(oldState.channelId);
                }
                sendSystemLog(oldState.guild, "INFO", "Xóa Phòng", `Phòng: **${oldState.channel.name}** đã đóng.`);
                if (linkedText) await linkedText.delete().catch(()=>{});
                await oldVoice.delete().catch(()=>{});
            } else if (linkedText) {
                await linkedText.permissionOverwrites.delete(oldState.member.id).catch(()=>{});
            }
        } else if (linkedText && linkedText.topic === oldState.channelId) await linkedText.delete().catch(()=>{});
    }
});

// --- INTERACTION ---
client.on('interactionCreate', async interaction => {
    if (!interaction.channel || !interaction.channel.topic) return;
    const voiceChannel = interaction.guild.channels.cache.get(interaction.channel.topic);
    if (!voiceChannel) return interaction.reply({ content: "❌ Phòng không tồn tại!", ephemeral: true });

    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
        const member = interaction.member;
        
        if (interaction.customId === 'btn_claim') {
            const currentOwner = voiceChannel.members.find(m => m.permissionsIn(voiceChannel).has(PermissionsBitField.Flags.ManageChannels));
            if (currentOwner && currentOwner.id !== member.id) return interaction.reply({ content: `⚠️ Chủ phòng vẫn còn đây!`, ephemeral: true });
            await voiceChannel.permissionOverwrites.set([{ id: interaction.guild.id, allow: [PermissionsBitField.Flags.Connect] }, { id: member.id, allow: [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ManageChannels] }]);
            await interaction.channel.permissionOverwrites.edit(member.id, { ViewChannel: true, SendMessages: true });
            sendSystemLog(interaction.guild, "WARNING", "Chiếm Quyền", `User <@${member.id}> lấy quyền phòng **${voiceChannel.name}**`, member.user);
            return interaction.reply({ content: `👑 **${member.user.username}** là chủ phòng mới!`, ephemeral: false });
        }

        const isOwner = voiceChannel.permissionsFor(member).has(PermissionsBitField.Flags.ManageChannels);
        if (!isOwner && !['btn_stats', 'btn_leaderboard'].includes(interaction.customId)) { 
            return interaction.reply({ content: "⚠️ Chỉ chủ phòng mới dùng được!", ephemeral: true });
        }

        try {
            // --- MENU MODES ---
            if (interaction.isStringSelectMenu() && interaction.customId === 'select_mode') {
                const mode = interaction.values[0];
                const maxBitrate = interaction.guild.maximumBitrate;

                if (mode === 'mode_gaming') {
                    await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { Connect: true, ViewChannel: true });
                    await voiceChannel.setBitrate(maxBitrate);
                    await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: true });
                    sendSystemLog(interaction.guild, "UPDATE", "Mode: Gaming", `Phòng **${voiceChannel.name}**`, member.user);
                    return interaction.reply({ content: `🎮 **Đã bật Gaming Mode!**`, ephemeral: true });
                }
                if (mode === 'mode_private') {
                    await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { Connect: false, ViewChannel: false });
                    await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: false });
                    sendSystemLog(interaction.guild, "WARNING", "Mode: Private", `Phòng **${voiceChannel.name}**`, member.user);
                    return interaction.reply({ content: `🤫 **Đã bật Private Mode!**`, ephemeral: true });
                }
                if (mode.startsWith('timer_')) {
                    const timeKey = mode.split('_')[1];
                    if (timeKey === 'off') {
                        if (sleepTimers.has(voiceChannel.id)) { clearTimeout(sleepTimers.get(voiceChannel.id)); sleepTimers.delete(voiceChannel.id); return interaction.reply({ content: `❌ **Đã hủy hẹn giờ!**`, ephemeral: true }); }
                        return interaction.reply({ content: `⚠️ Chưa đặt hẹn giờ.`, ephemeral: true });
                    }
                    const minutes = parseInt(timeKey);
                    if (sleepTimers.has(voiceChannel.id)) clearTimeout(sleepTimers.get(voiceChannel.id));
                    const timer = setTimeout(async () => {
                        try {
                            if (voiceChannel) {
                                for (const [mid, m] of voiceChannel.members) await m.voice.disconnect("Hết giờ!").catch(()=>{});
                                await voiceChannel.delete().catch(()=>{});
                                sendSystemLog(interaction.guild, "CHAOS", "Timer: Giải Tán", `Phòng **${voiceChannel.name}** đã đóng.`, null);
                            }
                        } catch(e) {}
                    }, minutes * 60 * 1000);
                    sleepTimers.set(voiceChannel.id, timer);
                    sendSystemLog(interaction.guild, "CHAOS", "Hẹn Giờ", `Phòng **${voiceChannel.name}** sẽ hủy sau **${minutes}p**.`, member.user);
                    return interaction.reply({ content: `⏱️ **Đã hẹn giờ:** ${minutes} phút.`, ephemeral: false });
                }
            }

            // --- BUTTON ACTIONS ---
            switch (interaction.customId) {
                case 'btn_mute_all':
                    const currentMuteState = muteAllStates.get(voiceChannel.id) || false;
                    const newMuteState = !currentMuteState; 
                    const membersToMute = voiceChannel.members.filter(m => m.id !== member.id && !m.user.bot);
                    for (const [mid, m] of membersToMute) await m.voice.setMute(newMuteState).catch(()=>{});
                    muteAllStates.set(voiceChannel.id, newMuteState);
                    if (newMuteState) {
                        sendSystemLog(interaction.guild, "WARNING", "Thiết Quân Luật", `Chủ phòng đã Mute tất cả.`, member.user);
                        interaction.reply({ content: `🔇 **THIẾT QUÂN LUẬT!** Đã khóa mic tất cả mọi người.`, ephemeral: true });
                    } else {
                        sendSystemLog(interaction.guild, "SUCCESS", "Hủy Thiết Quân Luật", `Chủ phòng đã Unmute mọi người.`, member.user);
                        interaction.reply({ content: `🔊 **Đã mở lại Mic!**`, ephemeral: true });
                    }
                    break;
                case 'btn_summon':
                    const memberList = voiceChannel.members.map(m => `<@${m.id}>`).join(' ');
                    if (!memberList) return interaction.reply({ content: "⚠️ Phòng có mỗi mình bạn à!", ephemeral: true });
                    interaction.reply({ content: `📣 **TRIỆU TẬP:** ${memberList}\n**CHỦ PHÒNG GỌI! TẬP TRUNG NGAY!**`, allowedMentions: { users: voiceChannel.members.map(m=>m.id) } });
                    sendSystemLog(interaction.guild, "UPDATE", "Triệu Hồi", `Đã ping tất cả thành viên.`, member.user);
                    break;
                case 'btn_dice':
                    const d1 = Math.floor(Math.random() * 6) + 1, d2 = Math.floor(Math.random() * 6) + 1, d3 = Math.floor(Math.random() * 6) + 1;
                    const t = d1 + d2 + d3, r = t >= 11 ? "TÀI 🔴" : "XỈU ⚫";
                    interaction.reply({ embeds: [new EmbedBuilder().setColor(t >= 11 ? 0xFF0000 : 0x000000).setTitle(`🎲 Xúc Xắc May Mắn`).setDescription(`🎲 **${d1}** | 🎲 **${d2}** | 🎲 **${d3}**\n\nTổng: **${t}** ➔ **${r}**`).setFooter({ text: `Lắc bởi: ${member.user.username}` })] });
                    sendSystemLog(interaction.guild, "GAME", "Chơi Tài Xỉu", `Kết quả: ${t} (${r})`, member.user);
                    break;
                case 'btn_nuke':
                    const allMems = voiceChannel.members.filter(m => !m.user.bot && m.id !== member.id);
                    if (allMems.size === 0) return interaction.reply({ content: "⚠️ Phòng trống!", ephemeral: true });
                    allMems.forEach(m => m.voice.disconnect("Nuke!"));
                    sendSystemLog(interaction.guild, "DANGER", "NUKE BUTTON", `Đã kích hoạt bom hạt nhân! ☢️`, member.user);
                    interaction.reply({ content: `☢️ **NUKE INCOMING!** Đã dọn sạch phòng!`, ephemeral: false });
                    break;
                case 'btn_roulette':
                    const victims = voiceChannel.members.filter(m => !m.user.bot && m.id !== member.id);
                    if (victims.size === 0) return interaction.reply({ content: "⚠️ Không có ai để bắn!", ephemeral: true });
                    const victim = victims.random();
                    await victim.voice.disconnect("Dính đạn Roulette!");
                    sendSystemLog(interaction.guild, "CHAOS", "Russian Roulette", `<@${member.id}> đã bắn <@${victim.id}> bay màu! 🔫`, member.user);
                    interaction.reply({ content: `🔫 **BÙM!** <@${victim.id}> đã dính đạn và bay khỏi phòng!`, ephemeral: false });
                    break;
                case 'btn_glitch':
                    const glitchNames = ["E̴r̴r̴o̴r̴ ̴4̴0̴4̴", "Nul̴l̴P̴o̴i̴n̴t̴e̴r̴", "System 32 Deleted", "⚠ Cursed Room ⚠", "H̷E̷L̷P̷ ̷M̷E̷"];
                    const randomName = glitchNames[Math.floor(Math.random() * glitchNames.length)];
                    await voiceChannel.setName(randomName).catch(()=>{});
                    interaction.reply({ content: `🐛 **Glitch Mode Activated!**`, ephemeral: true });
                    break;
                case 'btn_ghost_mode':
                    if (ghostModeChannels.has(voiceChannel.id)) {
                        ghostModeChannels.delete(voiceChannel.id);
                        sendSystemLog(interaction.guild, "UPDATE", "Tắt Ghost Mode", `Phòng **${voiceChannel.name}**`, member.user);
                        interaction.reply({ content: `⚪ **Đã TẮT Ghost Mode!**`, ephemeral: true });
                    } else {
                        ghostModeChannels.add(voiceChannel.id);
                        sendSystemLog(interaction.guild, "CHAOS", "Bật Ghost Mode", `Phòng **${voiceChannel.name}**`, member.user);
                        interaction.reply({ content: `👻 **Đã BẬT Ghost Mode!** Tin nhắn tự hủy sau 10s.`, ephemeral: false });
                    }
                    break;
                case 'btn_lock': await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { Connect: false }); sendSystemLog(interaction.guild, "WARNING", "Khóa Phòng", `Phòng: **${voiceChannel.name}**`, member.user); interaction.reply({content: "🔒 Đã khóa!", ephemeral: true}); break;
                case 'btn_unlock': await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { Connect: true }); sendSystemLog(interaction.guild, "WARNING", "Mở Phòng", `Phòng: **${voiceChannel.name}**`, member.user); interaction.reply({content: "🔓 Đã mở!", ephemeral: true}); break;
                case 'btn_rename': const mRename = new ModalBuilder().setCustomId('modal_rename').setTitle('Đổi tên').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_name').setLabel("Tên mới").setStyle(TextInputStyle.Short).setRequired(true))); await interaction.showModal(mRename); break;
                case 'btn_limit': const mLimit = new ModalBuilder().setCustomId('modal_limit').setTitle('Slot').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inp_limit').setLabel("Số lượng").setStyle(TextInputStyle.Short).setRequired(true))); await interaction.showModal(mLimit); break;
                case 'btn_bitrate': const max = interaction.guild.maximumBitrate; if(voiceChannel.bitrate < max) { await voiceChannel.setBitrate(max); sendSystemLog(interaction.guild, "UPDATE", "Nâng Cấp Audio", `Phòng: **${voiceChannel.name}**`, member.user); interaction.reply({content: `🔊 Max Audio: **${max/1000}kbps**`, ephemeral: true}); } else interaction.reply({content: "🔊 Đã Max rồi!", ephemeral: true}); break;
                case 'btn_toggle_chat': const canSend = interaction.channel.permissionsFor(interaction.guild.id).has(PermissionsBitField.Flags.SendMessages); await interaction.channel.permissionOverwrites.edit(interaction.guild.id, { SendMessages: !canSend, AttachFiles: !canSend }); sendSystemLog(interaction.guild, "WARNING", canSend ? "Khóa Chat" : "Mở Chat", `Phòng: **${voiceChannel.name}**`, member.user); interaction.reply({content: canSend ? "📵 Đã khóa Chat!" : "💬 Đã mở Chat!", ephemeral: true}); break;
                case 'btn_kick_menu': const members = voiceChannel.members.filter(m => !m.user.bot && m.id !== member.id); if (members.size === 0) return interaction.reply({content: "❌ Phòng trống!", ephemeral: true}); const menu = new StringSelectMenuBuilder().setCustomId('sel_kick').setPlaceholder("Chọn người...").addOptions(members.map(m => new StringSelectMenuOptionBuilder().setLabel(m.user.username).setValue(m.id))); interaction.reply({content: "🫥 Chọn người kick:", components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true}); break;
                case 'btn_save_config': saveSettings(member.id, voiceChannel.name, voiceChannel.userLimit); sendSystemLog(interaction.guild, "SUCCESS", "Lưu Cấu Hình", `User: <@${member.id}>`, member.user); interaction.reply({content: "💾 Đã lưu!", ephemeral: true}); break;
                case 'btn_reset_config': deleteSettings(member.id); sendSystemLog(interaction.guild, "WARNING", "Xóa Config", `User: <@${member.id}>`, member.user); interaction.reply({content: "🗑️ Đã xóa config!", ephemeral: true}); break;
                case 'btn_stats': const data = loadVoiceData(); const userData = data[member.id] || { totalTime: 0 }; let currentSession = 0; if (voiceSessions.has(member.id)) currentSession = Date.now() - voiceSessions.get(member.id); const total = userData.totalTime + currentSession; const embed = new EmbedBuilder().setColor('#00FF00').setTitle(`⏱️ Thống kê: ${member.user.username}`).addFields({ name: 'Phiên hiện tại', value: formatTime(currentSession), inline: true }, { name: 'Tổng thời gian', value: formatTime(total), inline: true }); return interaction.reply({ embeds: [embed], ephemeral: true });
                case 'btn_leaderboard': const dataL = loadVoiceData(); const sorted = Object.entries(dataL).sort(([, a], [, b]) => b.totalTime - a.totalTime).slice(0, 10); if (sorted.length === 0) return interaction.reply({ content: "📭 Chưa có dữ liệu!", ephemeral: true }); let desc = sorted.map((e, i) => `${i===0?"🥇":i===1?"🥈":i===2?"🥉":`#${i+1}`} <@${e[0]}>: **${formatTime(e[1].totalTime)}**`).join('\n'); return interaction.reply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle(`🏆 BXH Voice Server`).setDescription(desc)], ephemeral: true });
            }
        } catch (err) { console.log(err); interaction.reply({content: "❌ Lỗi!", ephemeral: true}).catch(()=>{}); }
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId === 'modal_rename') {
            const name = interaction.fields.getTextInputValue('inp_name');
            await voiceChannel.setName(name).catch(()=>{});
            sendSystemLog(interaction.guild, "UPDATE", "Đổi Tên", `Tên mới: **${name}**`, interaction.member.user);
            interaction.reply({content: `✅ Đã đổi tên!`, ephemeral: true});
        }
        if (interaction.customId === 'modal_limit') {
            const limit = parseInt(interaction.fields.getTextInputValue('inp_limit'));
            if (!isNaN(limit)) {
                await voiceChannel.setUserLimit(limit).catch(()=>{});
                sendSystemLog(interaction.guild, "UPDATE", "Đổi Slot", `Số lượng: **${limit}**`, interaction.member.user);
                interaction.reply({content: `✅ Slot: ${limit}`, ephemeral: true});
            }
        }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'sel_kick') {
        const target = voiceChannel.members.get(interaction.values[0]);
        if (target) { 
            target.voice.disconnect(); 
            sendSystemLog(interaction.guild, "DANGER", "Kick User", `User <@${target.id}> bị kick bởi <@${interaction.user.id}>`, interaction.user);
            interaction.update({content: `✅ Kicked ${target.user.username}`, components: []}); 
        }
    }

    if (interaction.isUserSelectMenu()) {
        const users = interaction.users;
        if (interaction.customId === 'select_trust') {
            users.forEach(async u => await voiceChannel.permissionOverwrites.edit(u.id, { Connect: true, ViewChannel: true }));
            sendSystemLog(interaction.guild, "SUCCESS", "Trust User", `Trust: ${users.map(u=>u.username).join(', ')}`, interaction.user);
            interaction.update({content: `🤝 Đã Trust!`, components: []});
        }
        if (interaction.customId === 'select_block') {
            users.forEach(async u => {
                await voiceChannel.permissionOverwrites.edit(u.id, { Connect: false, ViewChannel: false });
                const m = voiceChannel.members.get(u.id); if(m) m.voice.disconnect();
            });
            sendSystemLog(interaction.guild, "DANGER", "Block User", `Block: ${users.map(u=>u.username).join(', ')}`, interaction.user);
            interaction.update({content: `⛔ Đã Block!`, components: []});
        }
    }
});

client.login(TOKEN);

// --- KEEP ALIVE CHO RENDER ---
app.get('/', (req, res) => {
    res.send('Bot Discord Auto Room đang chạy... 🤖');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`🌏 Web Server đang chạy tại port: ${port}`);
});