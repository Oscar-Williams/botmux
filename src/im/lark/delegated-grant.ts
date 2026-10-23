/**
 * 委托授权：受信 bot（`grantDelegateBots`）在群里 @ 本 bot 时，把同一条消息里被它点名的
 * 其他人写进本群 chatGrants —— 与 owner 在授权卡上点「本群」同效（talk-only，额度/有效期
 * 取 /grant 的默认值），省掉「被点名的人 @ 本 bot → 弹申请卡 → 等 owner 手点」这一轮。
 *
 * 典型用法：外部平台用自己的 bot 建群拉人，再发一张 @本 bot 的开场卡，卡里同时 @ 提需求的人；
 * 平台自己点名的人就是它想让本 bot 服务的人，无需 owner 逐个批。
 *
 * 信任锚是飞书盖章的 bot 发送方（调用方只在 sender_type=app|bot 分支调用）+ owner 在
 * bots.json 显式列出的 bot 身份；绝不写 allowedUsers / allowedChatGroups / globalGrants，
 * 不授 canOperate。已经能和本 bot 对话的人（owner、oncall 群成员、已有授权……）跳过，不重复落库。
 */
import { getBot, getBotOpenId } from '../../bot-registry.js';
import { canTalk } from './event-dispatcher.js';
import { parseGrantTargets } from './grant-command.js';
import { buildGrantResultCard } from './card-builder.js';
import { replyMessage } from './client.js';
import { addChatGrant } from '../../services/grant-store.js';
import { DEFAULT_GRANT_DURATION_MS, DEFAULT_GRANT_QUOTA } from '../../services/grant-policy.js';
import { localeForBot } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

/** 发送方是否是本 bot 配置的委托授权 bot。open_id（本 app 视角）或 app_id 任一命中即算。 */
export function isGrantDelegateSender(larkAppId: string, senderIds: Array<string | undefined>): boolean {
  const delegates = getBot(larkAppId).config.grantDelegateBots;
  if (!delegates?.length) return false;
  return senderIds.some(id => !!id && delegates.includes(id));
}

/**
 * 处理一条已确认 @ 了本 bot 的 bot 消息。发送方不是委托 bot / 非群聊 / 没有可授权的人时什么都不做。
 * 返回本次新授权的 open_id 列表。
 */
export async function applyDelegatedGrants(
  larkAppId: string,
  message: any,
  opts: { chatType: 'group' | 'p2p'; senderIds: Array<string | undefined> },
): Promise<string[]> {
  const chatId: string | undefined = message?.chat_id;
  if (opts.chatType !== 'group' || !chatId) return [];
  if (!isGrantDelegateSender(larkAppId, opts.senderIds)) return [];

  const senders = new Set(opts.senderIds.filter((x): x is string => !!x));
  const targets = parseGrantTargets(message, getBotOpenId(larkAppId))
    .filter(tgt => tgt.openId !== 'all' && !senders.has(tgt.openId))
    .filter(tgt => !canTalk(larkAppId, chatId, tgt.openId));
  if (targets.length === 0) return [];

  const config = getBot(larkAppId).config;
  const quota = config.messageQuota?.defaultLimit ?? DEFAULT_GRANT_QUOTA;
  const durationMs = config.grantDefaultDurationMs ?? DEFAULT_GRANT_DURATION_MS;
  const expiresAt = Date.now() + durationMs;

  const granted: Array<{ openId: string; name?: string }> = [];
  for (const tgt of targets) {
    try {
      const r = await addChatGrant(larkAppId, chatId, tgt.openId, quota, expiresAt);
      if (r.ok) granted.push({ openId: tgt.openId, name: tgt.name });
      else logger.warn(`[grant:${larkAppId}] delegated grant failed for ${tgt.openId}: ${r.reason}`);
    } catch (err) {
      logger.warn(`[grant:${larkAppId}] delegated grant threw for ${tgt.openId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (granted.length === 0) return [];

  logger.info(`[grant:${larkAppId}] delegated chat grant by ${[...senders].join('/')} in ${chatId}: ${granted.map(g => g.openId).join(', ')}`);
  // 回一张与 owner 点卡授权后相同的结果卡：@ 被授权人 + 额度/有效期，让 ta 知道可以直接 @ 本 bot、能用多久。
  const card = buildGrantResultCard('chat', localeForBot(larkAppId), quota, expiresAt, granted);
  await replyMessage(larkAppId, message.message_id, card, 'interactive')
    .catch(err => logger.debug(`delegated grant notify failed: ${err}`));
  return granted.map(g => g.openId);
}
