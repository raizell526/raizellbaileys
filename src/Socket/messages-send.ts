
import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults'
import { AnyMessageContent, MediaConnInfo, MessageReceiptType, MessageRelayOptions, MiscMessageGenerationOptions, SocketConfig, WAMessageKey, WAMediaUploadFunctionOpts } from '../Types'
import { aggregateMessageKeysNotFromMe, assertMediaContent, bindWaitForEvent, decryptMediaRetryData, encodeSignedDeviceIdentity, encodeWAMessage, encryptMediaRetryRequest, extractDeviceJids, generateMessageIDV2, generateWAMessage, getStatusCodeForMediaRetry, getUrlFromDirectPath, getWAUploadToServer, normalizeMessageContent, parseAndInjectE2ESessions, getContentType, unixTimestampSeconds, delay, encodeNewsletterMessage } from '../Utils'
import { getUrlInfo } from '../Utils/link-preview'
import { areJidsSameUser, BinaryNode, BinaryNodeAttributes, getBinaryNodeChild, getBinaryNodeChildren, isJidGroup, isJidUser, jidDecode, jidEncode, jidNormalizedUser, JidWithDevice, S_WHATSAPP_NET, STORIES_JID, isJidNewsletter } from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import { Readable } from 'stream'
import { makeNewsletterSocket } from './newsletter'

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: axiosOptions,
		patchMessageBeforeSending,
	} = config
	const sock = makeNewsletterSocket(config)

	const {
		ev,
		authState,
		processingMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		sendNode,
		groupMetadata,
		groupToggleEphemeral,
	} = sock

	const userDevicesCache = config.userDevicesCache || new NodeCache({
		stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
		useClones: false
	})

	let mediaConn: Promise<MediaConnInfo>
	const refreshMediaConn = async(forceGet = false) => {
		const media = await mediaConn
		if(!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
			mediaConn = (async() => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET,
					},
					content: [ { tag: 'media_conn', attrs: { } } ]
				})
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn')
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(
						({ attrs }) => ({
							hostname: attrs.hostname,
							maxContentLengthBytes: +attrs.maxContentLengthBytes,
						})
					),
					auth: mediaConnNode!.attrs.auth,
					ttl: +mediaConnNode!.attrs.ttl,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				return node
			})()
		}

		return mediaConn
	}

	/**
     * generic send receipt function
     * used for receipts of phone call, read, delivery etc.
     * */
	const sendReceipt = async(jid: string, participant: string | undefined, messageIds: string[], type: MessageReceiptType) => {
		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0],
			},
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if(isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString()
		}

		if(type === 'sender' && isJidUser(jid)) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if(participant) {
				node.attrs.participant = participant
			}
		}

		if(type) {
			node.attrs.type = isJidNewsletter(jid) ? 'read-self' : type
		}

		const remainingMessageIds = messageIds.slice(1)
		if(remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: { },
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async(keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys)
		for(const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async(keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings()
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
 	}

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = async(jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => {
		const deviceResults: JidWithDevice[] = []

		if(!useCache) {
			logger.debug('not using cache for devices')
		}

		const toFetch: string[] = []
		jids = Array.from(new Set(jids))

		for(let jid of jids) {
			const user = jidDecode(jid)?.user
			jid = jidNormalizedUser(jid)
			if(useCache) {
				const devices = userDevicesCache.get<JidWithDevice[]>(user!)
				if(devices) {
					deviceResults.push(...devices)

					logger.trace({ user }, 'using cache for devices')
				} else {
					toFetch.push(jid)
				}
			} else {
				toFetch.push(jid)
			}
		}

		if(!toFetch.length) {
			return deviceResults
		}

		const query = new USyncQuery()
			.withContext('message')
			.withDeviceProtocol()

		for(const jid of toFetch) {
			query.withUser(new USyncUser().withId(jid))
		}

		const result = await sock.executeUSyncQuery(query)

		if(result) {
			const extracted = extractDeviceJids(result?.list, authState.creds.me!.id, ignoreZeroDevices)
			const deviceMap: { [_: string]: JidWithDevice[] } = {}

			for(const item of extracted) {
				deviceMap[item.user] = deviceMap[item.user] || []
				deviceMap[item.user].push(item)

				deviceResults.push(item)
			}

			for(const key in deviceMap) {
				userDevicesCache.set(key, deviceMap[key])
			}
		}

		return deviceResults
	}

	const assertSessions = async(jids: string[], force: boolean) => {
		let didFetchNewSession = false
		let jidsRequiringFetch: string[] = []
		if(force) {
			jidsRequiringFetch = jids
		} else {
			const addrs = jids.map(jid => (
				signalRepository
					.jidToSignalProtocolAddress(jid)
			))
			const sessions = await authState.keys.get('session', addrs)
			for(const jid of jids) {
				const signalId = signalRepository
					.jidToSignalProtocolAddress(jid)
				if(!sessions[signalId]) {
					jidsRequiringFetch.push(jid)
				}
			}
		}

		if(jidsRequiringFetch.length) {
			logger.debug({ jidsRequiringFetch }, 'fetching sessions')
			const result = await query({
				tag: 'iq',
				attrs: {
					xmlns: 'encrypt',
					type: 'get',
					to: S_WHATSAPP_NET,
				},
				content: [
					{
						tag: 'key',
						attrs: { },
						content: jidsRequiringFetch.map(
							jid => ({
								tag: 'user',
								attrs: { jid },
							})
						)
					}
				]
			})
			await parseAndInjectE2ESessions(result, signalRepository)

			didFetchNewSession = true
		}

		return didFetchNewSession
	}

	const sendPeerDataOperationMessage = async(
		pdoMessage: proto.Message.IPeerDataOperationRequestMessage
	): Promise<string> => {
		//TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
		if(!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const protocolMessage: proto.IMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}

		const meJid = jidNormalizedUser(authState.creds.me.id)

		const msgId = await relayMessage(meJid, protocolMessage, {
			additionalAttributes: {
				category: 'peer',
				// eslint-disable-next-line camelcase
				push_priority: 'high_force',
			},
		})

		return msgId
	}

	const createParticipantNodes = async(
		jids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs']
	) => {
		let patched = await patchMessageBeforeSending(message, jids)
		if(!Array.isArray(patched)) {
		  patched = jids ? jids.map(jid => ({ recipientJid: jid, ...patched })) : [patched]
		}

		let shouldIncludeDeviceIdentity = false

		const nodes = await Promise.all(
			patched.map(
				async patchedMessageWithJid => {
					const { recipientJid: jid, ...patchedMessage } = patchedMessageWithJid
					if(!jid) {
					  return {} as BinaryNode
					}

					const bytes = encodeWAMessage(patchedMessage)
					const { type, ciphertext } = await signalRepository
						.encryptMessage({ jid, data: bytes })
					if(type === 'pkmsg') {
						shouldIncludeDeviceIdentity = true
					}

					const node: BinaryNode = {
						tag: 'to',
						attrs: { jid },
						content: [{
							tag: 'enc',
							attrs: {
								v: '2',
								type,
								...extraAttrs || {}
							},
							content: ciphertext
						}]
					}
					return node
				}
			)
		)
		return { nodes, shouldIncludeDeviceIdentity }
	}

	const relayMessage = async(
		jid: string,
		message: proto.IMessage,
		{ messageId: msgId, participant, additionalAttributes, additionalNodes, useUserDevicesCache, useCachedGroupMetadata, statusJidList, cachedGroupMetadata }: MessageRelayOptions
	) => {
		const meId = authState.creds.me!.id

		let shouldIncludeDeviceIdentity = false
		let didPushAdditional = false
		
		const { user, server } = jidDecode(jid)!
		const statusJid = 'status@broadcast'
		const isGroup = server === 'g.us'
		const isStatus = jid === statusJid
		const isLid = server === 'lid'
		const isNewsletter = server === 'newsletter'

		msgId = msgId || generateMessageIDV2(sock.user?.id)
		useUserDevicesCache = useUserDevicesCache !== false
		useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

		const participants: BinaryNode[] = []
		const destinationJid = (!isStatus) ? jidEncode(user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net') : statusJid
		const binaryNodeContent: BinaryNode[] = []
		const devices: JidWithDevice[] = []

		const meMsg: proto.IMessage = {
			deviceSentMessage: {
				destinationJid,
				message
			}
		}

		const extraAttrs = {}

		if(participant) {
			// when the retry request is not for a group
			// only send to the specific device that asked for a retry
			// otherwise the message is sent out to every device that should be a recipient
			if(!isGroup && !isStatus) {
				additionalAttributes = { ...additionalAttributes, 'device_fanout': 'false' }
			}

			const { user, device } = jidDecode(participant.jid)!
			devices.push({ user, device })
		}

		await authState.keys.transaction(
			async() => {
				const mediaType = getMediaType(message)
				if(mediaType) {
					extraAttrs['mediatype'] = mediaType
				}

				if(normalizeMessageContent(message)?.pinInChatMessage) {
					extraAttrs['decrypt-fail'] = 'hide'
				}

				if(isGroup || isStatus) {
					const [groupData, senderKeyMap] = await Promise.all([
						(async() => {
							let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
							if(groupData && Array.isArray(groupData?.participants)) {
								logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
							} else if(!isStatus) {
								groupData = await groupMetadata(jid)
							}

							return groupData
						})(),
						(async() => {
							if(!participant && !isStatus) {
								const result = await authState.keys.get('sender-key-memory', [jid])
								return result[jid] || { }
							}

							return { }
						})()
					])

					if(!participant) {
						const participantsList = (groupData && !isStatus) ? groupData.participants.map(p => p.id) : []
						if(isStatus && statusJidList) {
							participantsList.push(...statusJidList)
						}
				
						if(!isStatus) {
							additionalAttributes = {
								...additionalAttributes,
								addressing_mode: groupData?.addressingMode || 'pn'
							}
						}

						const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
						devices.push(...additionalDevices)
					}

					const patched = await patchMessageBeforeSending(message, devices.map(d => jidEncode(d.user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net', d.device)))

					if(Array.isArray(patched)) {
					  throw new Boom('Per-jid patching is not supported in groups')
					}

					const bytes = encodeWAMessage(patched)

					const { ciphertext, senderKeyDistributionMessage } = await signalRepository.encryptGroupMessage(
						{
							group: destinationJid,
							data: bytes,
							meId,
						}
					)

					const senderKeyJids: string[] = []
					// ensure a connection is established with every device
					for(const { user, device } of devices) {
						const jid = jidEncode(user, groupData?.addressingMode === 'lid' ? 'lid' : 's.whatsapp.net', device)
						if(!senderKeyMap[jid] || !!participant) {
							senderKeyJids.push(jid)
							// store that this person has had the sender keys sent to them
							senderKeyMap[jid] = true
						}
					}

					// if there are some participants with whom the session has not been established
					// if there are, we re-send the senderkey
					if(senderKeyJids.length) {
						logger.debug({ senderKeyJids }, 'sending new sender key')

						const senderKeyMsg: proto.IMessage = {
							senderKeyDistributionMessage: {
								axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
								groupId: destinationJid
							}
						}

						await assertSessions(senderKeyJids, false)

						const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs)
						shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity

						participants.push(...result.nodes)
					}

					binaryNodeContent.push({
						tag: 'enc',
						attrs: { v: '2', type: 'skmsg' },
						content: ciphertext
					})

					await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
				} else if (isNewsletter) {
				const patched = await patchMessageBeforeSending(message, [])

				// TAMBAHKAN PENGECEKAN INI
				if (Array.isArray(patched)) {
					// Ini seharusnya tidak terjadi untuk newsletter, jadi kita hentikan prosesnya
					throw new Error('patchMessageBeforeSending returned an array for a single newsletter message')
				}
				// SETELAH PENGECEKAN, 'patched' DIJAMIN BUKAN ARRAY
				
				const bytes = proto.Message.encode(patched).finish() // <-- SEKARANG AMAN
				
				binaryNodeContent.push({
					tag: 'plaintext',
					attrs: mediaType ? { mediatype: mediaType } : {},
					content: bytes
				})
			} else {
					const { user: meUser } = jidDecode(meId)!

					if(!participant) {
						devices.push({ user })
						if(user !== meUser) {
							devices.push({ user: meUser })
						}

						if(additionalAttributes?.['category'] !== 'peer') {
							const additionalDevices = await getUSyncDevices([ meId, jid ], !!useUserDevicesCache, true)
							devices.push(...additionalDevices)
						}
					}

					const allJids: string[] = []
					const meJids: string[] = []
					const otherJids: string[] = []
					for(const { user, device } of devices) {
						const isMe = user === meUser
						const jid = jidEncode(isMe && isLid ? authState.creds?.me?.lid!.split(':')[0] || user : user, isLid ? 'lid' : isGroup ? 'g.us' : isNewsletter ? 'newsletter' : 's.whatsapp.net', device)
						if(isMe) {
							meJids.push(jid)
						} else {
							otherJids.push(jid)
						}

						allJids.push(jid)
					}

					await assertSessions(allJids, false)

					const [
						{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
						{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }
					] = await Promise.all([
						createParticipantNodes(meJids, meMsg, extraAttrs),
						createParticipantNodes(otherJids, message, extraAttrs)
					])
					participants.push(...meNodes)
					participants.push(...otherNodes)

					shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
				}

				if(participants.length) {
					if(additionalAttributes?.['category'] === 'peer') {
						const peerNode = participants[0]?.content?.[0] as BinaryNode
						if(peerNode) {
							binaryNodeContent.push(peerNode) // push only enc
						}
					} else {
						binaryNodeContent.push({
							tag: 'participants',
							attrs: { },
							content: participants
						})
					}
				}
				
				const stanza: BinaryNode = {
					tag: 'message',
					attrs: {
						id: msgId!,
						type: isNewsletter ? getMessageType(message) : 'text',
						...(additionalAttributes || {})
					},
					content: binaryNodeContent
				}
				// if the participant to send to is explicitly specified (generally retry recp)
				// ensure the message is only sent to that person
				// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
				if(participant) {
					if(isJidGroup(destinationJid)) {
						stanza.attrs.to = destinationJid
						stanza.attrs.participant = participant.jid
					} else if(areJidsSameUser(participant.jid, meId)) {
						stanza.attrs.to = participant.jid
						stanza.attrs.recipient = destinationJid
					} else {
						stanza.attrs.to = participant.jid
					}
				} else {
					stanza.attrs.to = destinationJid
				}

				if(shouldIncludeDeviceIdentity) {
					(stanza.content as BinaryNode[]).push({
						tag: 'device-identity',
						attrs: { },
						content: encodeSignedDeviceIdentity(authState.creds.account!, true)
					})

					logger.debug({ jid }, 'adding device identity')
				}
				
				/*
				const messages = normalizeMessageContent(message);

if (messages) {
    const buttonType = getButtonType(messages);
    
    if (!isNewsletter && buttonType) {
        if (!stanza.content || !Array.isArray(stanza.content)) {
            stanza.content = [];
        }

        const buttonsNode = getButtonArgs(messages); 
        
        const filteredButtons = getBinaryFilteredButtons(additionalNodes || []);

        if (filteredButtons && additionalNodes) {
            (stanza.content as BinaryNode[]).push(...additionalNodes);
            didPushAdditional = true;
        } else {
            (stanza.content as BinaryNode[]).push(buttonsNode);
        }
    }
}
				
				const buttonType = getButtonType(message)
				if(buttonType) {
					(stanza.content as BinaryNode[]).push({
						tag: 'biz',
						attrs: { },
						content: [
							{
								tag: buttonType,
								attrs: getButtonArgs(message),
							}
						]
					})
				}
				*/
				if(additionalNodes && additionalNodes.length > 0) {
					(stanza.content as BinaryNode[]).push(...additionalNodes)
				}
				const Msg = normalizeMessageContent(message)!
                const key = getContentType(Msg)!
                if(!isNewsletter && ((key === 'interactiveMessage' && Msg?.interactiveMessage?.nativeFlowMessage) || key === 'buttonsMessage')) {
                    const nativeNode = {
						  tag: 'biz',
						  attrs: {},
					      content: [{
							  tag: 'interactive',
						  	  attrs: {
				   				  type: 'native_flow',
			      				  v: '1'
							  },
							content: [{
							tag: 'native_flow',
							attrs: {
								v: '9',
								name: 'mixed'
							}
						}]
    					  }]
				    }
                    const resultNativeNode = filterNativeNode(additionalNodes);
                    if(resultNativeNode && additionalNodes && additionalNodes.length > 0) {
				        (stanza.content as BinaryNode[]).push(...resultNativeNode);
				    } else {
				        (stanza.content as BinaryNode[]).push(nativeNode);
				    }
				}
				 				
				if(message.listMessage) {
					(stanza.content as BinaryNode[]).push({
						tag: 'biz',
						attrs: { },
						content: [
							{
								tag: 'list',
								attrs: getButtonArgs(message).attrs,
							}
						]
					});

					logger.debug({ jid }, 'adding business node')
				}

				logger.debug({ msgId }, `sending message to ${participants.length} devices`)

				await sendNode(stanza)
			}
		)

		return msgId
	}

	const getButtonType = (message: proto.IMessage) => {
	if (message.buttonsMessage) {
		return 'buttons'
	} else if (message.buttonsResponseMessage) {
		return 'buttons_response'
	} else if (message.interactiveResponseMessage) {
		return 'interactive_response'
	} else if (message.listMessage) {
		return 'list'
	} else if (message.listResponseMessage) {
		return 'list_response'
	} else if (message.interactiveMessage?.nativeFlowMessage) {
	return 'native_flow'
}
}

const getButtonArgs = (message: proto.IMessage): BinaryNode => {
  const nativeFlow = message.interactiveMessage?.nativeFlowMessage;
  const firstButtonName = nativeFlow && nativeFlow.buttons && nativeFlow.buttons[0] ? nativeFlow.buttons[0].name : undefined;


  const nativeFlowSpecials = [
    'mpm',
    'cta_catalog',
    'send_location',
    'call_permission_request',
    'wa_payment_transaction_details',
    'automated_greeting_message_view_catalog',
  ];

  if (nativeFlow && (firstButtonName === 'review_and_pay' || firstButtonName === 'payment_info')) {
    return {
      tag: 'biz',
      attrs: {
        native_flow_name: firstButtonName,
      },
    };
  } else if (firstButtonName && nativeFlowSpecials.includes(firstButtonName)
) {
    return {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: {
            type: 'native_flow',
            v: '1',
          },
          content: [
            {
              tag: 'native_flow',
              attrs: {
                v: '2',
                name: firstButtonName,
              },
            },
          ],
        },
      ],
    };
  } else if (message.buttonsMessage || nativeFlow) {
    return {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: {
            type: 'native_flow',
            v: '1',
          },
          content: [
            {
              tag: 'native_flow',
              attrs: {
                v: '9',
                name: 'mixed',
              },
            },
          ],
        },
      ],
    };
  } else if (message.listMessage) {
    return {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'list',
          attrs: {
            v: '2',
            type: 'product_list',
          },
        },
      ],
    };
  } else {
    return {
      tag: 'biz',
      attrs: {},
    };
  }
};

const filterNativeNode = (nodeContent) => {
        if(Array.isArray(nodeContent)) {
            return nodeContent!.filter((item) => {
                if(item!.tag === 'biz' && item?.content[0]?.tag === 'interactive' && item?.content[0]?.attrs?.type === 'native_flow' && item?.content[0]?.content[0]?.tag === 'native_flow' && item?.content[0]?.content[0]?.attrs?.name === 'quick_reply') {
                    return false;
                }
                return true;
            });
        } else {
            return nodeContent;
        }
    };
	const getMessageType = (msg: proto.IMessage) => {
		if (msg.viewOnceMessage) {
	return getMessageType(msg.viewOnceMessage.message!)
} else if (msg.viewOnceMessageV2) {
	return getMessageType(msg.viewOnceMessageV2.message!)
} else if (msg.viewOnceMessageV2Extension) {
	return getMessageType(msg.viewOnceMessageV2Extension.message!)
} else if (msg.ephemeralMessage) {
	return getMessageType(msg.ephemeralMessage.message!)
} else if (msg.documentWithCaptionMessage) {
	return getMessageType(msg.documentWithCaptionMessage.message!)
} else if (msg.reactionMessage) {
	return 'reaction'
} else if (msg.pollCreationMessage || msg.pollCreationMessageV2 || msg.pollCreationMessageV3 || msg.pollUpdateMessage) {
	return 'poll'
} else if (getMediaType(msg)) {
	return 'media'
} else {
	return 'text'
}
	}
	
	const getBinaryFilteredButtons = (nodeContent) => {
if (!Array.isArray(nodeContent)) return false
return nodeContent.some(a =>
['native_flow'].includes(a?.content?.[0]?.content?.[0]?.tag) ||
['interactive', 'buttons', 'list'].includes(a?.content?.[0]?.tag) ||
['hsm', 'biz'].includes(a?.tag)
)
}

	const getMediaType = (message: proto.IMessage) => {
		if(message.imageMessage) {
			return 'image'
		} else if(message.videoMessage) {
			return message.videoMessage.gifPlayback ? 'gif' : 'video'
		} else if(message.audioMessage) {
			return message.audioMessage.ptt ? 'ptt' : 'audio'
		} else if(message.contactMessage) {
			return 'vcard'
		} else if(message.documentMessage) {
			return 'document'
		} else if(message.contactsArrayMessage) {
			return 'contact_array'
		} else if(message.liveLocationMessage) {
			return 'livelocation'
		} else if(message.stickerMessage) {
			return 'sticker'
		} else if(message.listMessage) {
			return 'list'
		} else if(message.listResponseMessage) {
			return 'list_response'
		} else if(message.buttonsResponseMessage) {
			return 'buttons_response'
		} else if(message.orderMessage) {
			return 'order'
		} else if(message.productMessage) {
			return 'product'
		} else if(message.interactiveResponseMessage) {
			return 'native_flow_response'
		} else if(message.groupInviteMessage) {
			return 'url'
		}
	}

	const getPrivacyTokens = async(jids: string[]) => {
		const t = unixTimestampSeconds().toString()
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'privacy'
			},
			content: [
				{
					tag: 'tokens',
					attrs: { },
					content: jids.map(
						jid => ({
							tag: 'token',
							attrs: {
								jid: jidNormalizedUser(jid),
								t,
								type: 'trusted_contact'
							}
						})
					)
				}
			]
		})

		return result
	}

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)

	const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

	return {
		...sock,
		getPrivacyTokens,
		assertSessions,
		relayMessage,
		sendReceipt,
		getButtonArgs,
		sendReceipts,
		readMessages,
		refreshMediaConn,
		waUploadToServer,
		fetchPrivacySettings,
		sendPeerDataOperationMessage,
		createParticipantNodes,
		getUSyncDevices,
		sendStatusMentions: async(
		   content: AnyMessageContent, 
		   jids: string[] = [],
		   opts: { tag?: boolean } = {}
		) => {
		   const userJid = jidNormalizedUser(authState.creds.me!.id) 		       
           let allUsers: string[] = [];

           for(const id of jids) {
		      const { user, server } = jidDecode(id)!
		      const isGroup = server === 'g.us'
              const isPerson = server === 's.whatsapp.net'
              if(isGroup) {
                 let userId = await groupMetadata(id)
                 let participant = await userId.participants
                 let users = await Promise.all(participant.map(u => jidNormalizedUser(u.id))); 
                 allUsers = [...allUsers as string[], ...users as string[]];
              } else if(isPerson) {
                 let users = await Promise.all(jids.map(id => id.replace(/\b\d{18}@.{4}\b/g, '')));
                 allUsers = [...allUsers as string[], ...users as string[]];
              }
              if(!allUsers.find(user => user.includes(userJid))) {
                 (allUsers as string[]).push(userJid)
              }
           };
           const getRandomHexColor = () => {
              return "#" + Math.floor(Math.random() * 16777215)
                 .toString(16)
                 .padStart(6, "0");
           }
           let mediaHandle 
           let msg = await generateWAMessage(
               STORIES_JID, 
               content, 
               {
				   logger,
				   userJid,
				   getUrlInfo: text => getUrlInfo(
						text,
						{
							thumbnailWidth: linkPreviewImageThumbnailWidth,
							fetchOpts: {
								timeout: 3_000,
								...axiosOptions || { }
							},
							logger,
							uploadImage: generateHighQualityLinkPreview
							? waUploadToServer
							: undefined
						},
				   ),
				   upload: waUploadToServer,
				   mediaCache: config.mediaCache,
				   options: config.options,
                   backgroundColor: getRandomHexColor(),
                   font: Math.floor(Math.random() * 9),
               }
           );
           await relayMessage(STORIES_JID, msg.message!, { 
                   messageId: msg.key.id!, 
                   statusJidList: allUsers,
                   additionalNodes: [
                        {
                           tag: 'meta',
                           attrs: { },
                           content: [
                              { 
                                 tag: 'mentioned_users',
                                 attrs: { },
                                 content: jids.map(jid => ({
                                    tag: 'to',
                                    attrs: { jid },
                                    content: undefined,
                                    })
                                 ),
                              },
                           ],
                        },
                   ], 
               }
           );
           if (opts.tag) {
           jids.forEach(async id => {
               id = jidNormalizedUser(id)!
		       const { user, server } = jidDecode(id)!
               const isPerson = server === 's.whatsapp.net'
               let type = isPerson
                   ? 'statusMentionMessage' 
                   : 'groupStatusMentionMessage'
               await relayMessage(
                   id, 
                   {
                       [type]: {
                          message: {
                             protocolMessage: {
                                key: msg.key,
                                type: 25,
                             },
                          },
                       },
                   }, 
               { });
               await delay(2500)       
               }
           );
           }
           return msg
        },
		updateMediaMessage: async(message: proto.IWebMessageInfo) => {
			const content = assertMediaContent(message.message)
			const mediaKey = content.mediaKey!
			const meId = authState.creds.me!.id
			const node = await encryptMediaRetryRequest(message.key, mediaKey, meId)

			let error: Error | undefined = undefined
			await Promise.all(
				[
					sendNode(node),
					waitForMsgMediaUpdate(async(update) => {
						const result = update.find(c => c.key.id === message.key.id)
						if(result) {
							if(result.error) {
								error = result.error
							} else {
								try {
									const media = await decryptMediaRetryData(result.media!, mediaKey, result.key.id!)
									if(media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
										const resultStr = proto.MediaRetryNotification.ResultType[media.result!]
										throw new Boom(
											`Media re-upload failed by device (${resultStr})`,
											{ data: media, statusCode: getStatusCodeForMediaRetry(media.result!) || 404 }
										)
									}

									content.directPath = media.directPath
									content.url = getUrlFromDirectPath(content.directPath!)

									logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
								} catch(err) {
									error = err
								}
							}

							return true
						}
					})
				]
			)

			if(error) {
				throw error
			}

			ev.emit('messages.update', [
				{ key: message.key, update: { message: message.message } }
			])

			return message
		},
		sendMessage: async(
			jid: string,
			content: AnyMessageContent,
			options: MiscMessageGenerationOptions = { }
		) => {
			let mediaHandle
			const userJid = authState.creds.me!.id
			if(
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content
				const value = typeof disappearingMessagesInChat === 'boolean' ?
					(disappearingMessagesInChat ? WA_DEFAULT_EPHEMERAL : 0) :
					disappearingMessagesInChat
				await groupToggleEphemeral(jid, value)
			} else {
				
				const fullMsg = await generateWAMessage(
					jid,
					content,
					{
						logger,
						userJid,
						getUrlInfo: text => getUrlInfo(
							text,
							{
								thumbnailWidth: linkPreviewImageThumbnailWidth,
								fetchOpts: {
									timeout: 3_000,
									...axiosOptions || { }
								},
								logger,
								uploadImage: generateHighQualityLinkPreview
									? waUploadToServer
									: undefined
							},
						),
						//TODO: CACHE
						getProfilePicUrl: sock.profilePictureUrl,
						upload: waUploadToServer,
						mediaCache: config.mediaCache,
						options: config.options,
						messageId: generateMessageIDV2(sock.user?.id),
						...options,
					}
				)
				const isDeleteMsg = 'delete' in content && !!content.delete
				const isEditMsg = 'edit' in content && !!content.edit
				const isPinMsg = 'pin' in content && !!content.pin
				const isPollMessage = 'poll' in content && !!content.poll
				const isAiMsg = 'ai' in content && !!content.ai
				
				const additionalAttributes: BinaryNodeAttributes = { }
				const additionalNodes: BinaryNode[] = []
				// required for delete
				if(isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if(isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				} else if(isEditMsg) {
					additionalAttributes.edit = '1'
				} else if(isPinMsg) {
					additionalAttributes.edit = '2'
				} else if(isPollMessage) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							polltype: 'creation'
						},
					} as BinaryNode)
				} else if(isAiMsg) {
				    additionalNodes.push({
                        attrs: {
                            biz_bot: '1'
                        },
                        tag: 'bot'
                        }
                    )
				}

				if('cachedGroupMetadata' in options) {
					console.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.')
				}

				await relayMessage(jid, fullMsg.message!, {
					messageId: fullMsg.key.id!,
					useCachedGroupMetadata: options.useCachedGroupMetadata,
					additionalAttributes,
					statusJidList: options.statusJidList,
					additionalNodes
					
				})
				if(config.emitOwnEvents) {
					process.nextTick(() => {
						processingMutex.mutex(() => (
							upsertMessage(fullMsg, 'append')
						))
					})
				}

				return fullMsg
			}
		}
	}
}
