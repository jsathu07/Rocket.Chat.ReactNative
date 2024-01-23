import { sanitizedRaw } from '@nozbe/watermelondb/RawRecord';
import { Model, Q } from '@nozbe/watermelondb';
import moment from 'moment';

import database from '../database';
import log from './helpers/log';
import { random } from './helpers';
import { Encryption } from '../encryption';
import { E2EType, IMessage, IUser, TMessageModel, TThreadMessageModel, TUploadModel } from '../../definitions';
import sdk from '../services/sdk';
import { E2E_MESSAGE_TYPE, E2E_STATUS, messagesStatus } from '../constants';
import { sendFileMessage } from './sendFileMessage';
import { store } from '../store/auxStore';
import { getUserSelector } from '../../selectors/login';

export async function resendFailedMessages(): Promise<void> {
	try {
		const db = database.active;
		const batch: (TMessageModel | TThreadMessageModel | TUploadModel)[] = [];

		const messageRecords = await db
			.get('messages')
			.query(Q.or(Q.where('status', messagesStatus.ERROR), Q.where('status', messagesStatus.TEMP)), Q.where('tmid', null))
			.fetch();

		messageRecords.forEach(message => {
			batch.push(
				message.prepareUpdate(m => {
					m.status = messagesStatus.TEMP;
				})
			);
		});

		const threadRecords = await db
			.get('thread_messages')
			.query(Q.or(Q.where('status', messagesStatus.ERROR), Q.where('status', messagesStatus.TEMP)))
			.fetch();

		threadRecords.forEach(message => {
			batch.push(
				message.prepareUpdate(m => {
					m.status = messagesStatus.TEMP;
				})
			);
		});

		const uploadRecords = await db.get('uploads').query(Q.where('error', true)).fetch();

		uploadRecords.forEach(upload => {
			batch.push(
				upload.prepareUpdate(m => {
					m.error = false;
				})
			);
		});

		// don't let user automatically send messages until resend fails
		await db.write(async () => {
			await db.batch(...batch);
		});

		// filter all uploads initiated before migration
		const defaultDate = moment.unix(0).toDate();
		const filteredUploadRecords = uploadRecords.filter(
			(uploadFile: TUploadModel) => uploadFile.ts.getTime() !== defaultDate.getTime()
		);

		// FIXME: change any to proper type
		const allMessages: any = [...messageRecords, ...threadRecords, ...filteredUploadRecords];

		// db ts is always Date
		allMessages.sort((a: any, b: any) => (a.ts as Date).getTime() - (b.ts as Date).getTime());

		const { server } = store.getState().server;
		const user = getUserSelector(store.getState());

		for (let i = 0; i < allMessages.length; i++) {
			try {
				// FIXME: find any other way
				if (allMessages[i].size) {
					// eslint-disable-next-line no-await-in-loop
					await sendFile(allMessages[i], server, user);
				} else if (allMessages[i].tmid === null) {
					// eslint-disable-next-line no-await-in-loop
					await resendMessage(allMessages[i], undefined, true);
				} else {
					// eslint-disable-next-line no-await-in-loop
					await resendMessage(allMessages[i], allMessages[i].rid, true);
				}
			} catch (e) {
				// do nothing
			}
		}
	} catch {
		// let user initiate the retry
	}
}

const sendFile = async (item: TUploadModel, server: string, user: IUser) => {
	try {
		await sendFileMessage(item.rid as string, item, item.tmid, server, user, true);
	} catch (e) {
		log(e);
	}
};

const changeMessageStatus = async (id: string, status: number, tmid?: string, message?: IMessage) => {
	const db = database.active;
	const msgCollection = db.get('messages');
	const threadMessagesCollection = db.get('thread_messages');
	const successBatch: Model[] = [];
	const messageRecord = await msgCollection.find(id);
	successBatch.push(
		messageRecord.prepareUpdate(m => {
			m.status = status;
			if (message) {
				m.mentions = message.mentions;
				m.channels = message.channels;
			}
		})
	);

	if (tmid) {
		const threadMessageRecord = await threadMessagesCollection.find(id);
		successBatch.push(
			threadMessageRecord.prepareUpdate(tm => {
				tm.status = status;
				if (message) {
					tm.mentions = message.mentions;
					tm.channels = message.channels;
				}
			})
		);
	}

	try {
		await db.write(async () => {
			await db.batch(...successBatch);
		});
	} catch (error) {
		// Do nothing
	}
};

async function sendMessageCall(message: any) {
	const { _id, tmid } = message;
	try {
		// RC 0.60.0
		// @ts-ignore
		const result = await sdk.post('chat.sendMessage', { message });
		if (result.success) {
			// @ts-ignore
			return changeMessageStatus(_id, messagesStatus.SENT, tmid, result.message);
		}
	} catch {
		// do nothing
	}
	return changeMessageStatus(_id, messagesStatus.ERROR, tmid);
}

export async function resendMessage(message: TMessageModel, tmid?: string, isAutoResend?: boolean) {
	const db = database.active;
	try {
		let tshow;
		if (tmid) {
			tshow = (await db.get('messages').find(message.id)).tshow; // tshow only exists on this db
		}

		if (!isAutoResend) {
			await db.write(async () => {
				await message.update(m => {
					m.status = messagesStatus.TEMP;
				});
			});
		}

		const m = await Encryption.encryptMessage({
			_id: message.id,
			rid: message.subscription ? message.subscription.id : '',
			msg: message.msg,
			...(tmid && { tmid }),
			...(tmid && tshow && { tshow })
		} as IMessage);

		await sendMessageCall(m);
	} catch (e) {
		log(e);
	}
}

export async function sendMessage(
	rid: string,
	msg: string,
	tmid: string | undefined,
	user: Partial<Pick<IUser, 'id' | 'username' | 'name'>>,
	tshow?: boolean
): Promise<void> {
	try {
		const db = database.active;
		const subsCollection = db.get('subscriptions');
		const msgCollection = db.get('messages');
		const threadCollection = db.get('threads');
		const threadMessagesCollection = db.get('thread_messages');
		const messageId = random(17);
		const batch: Model[] = [];

		const message = await Encryption.encryptMessage({
			_id: messageId,
			rid,
			msg,
			tmid,
			tshow
		} as IMessage);

		const messageDate = new Date();
		let tMessageRecord: TMessageModel;

		// If it's replying to a thread
		if (tmid) {
			try {
				// Find thread message header in Messages collection
				tMessageRecord = await msgCollection.find(tmid);
				batch.push(
					tMessageRecord.prepareUpdate(m => {
						m.tlm = messageDate;
						if (m.tcount) {
							m.tcount += 1;
						}
					})
				);

				try {
					// Find thread message header in Threads collection
					await threadCollection.find(tmid);
				} catch (error) {
					// If there's no record, create one
					batch.push(
						threadCollection.prepareCreate(tm => {
							tm._raw = sanitizedRaw({ id: tmid }, threadCollection.schema);
							if (tm.subscription) {
								tm.subscription.id = rid;
							}
							tm.tmid = tmid;
							tm.msg = tMessageRecord.msg;
							tm.ts = tMessageRecord.ts;
							tm._updatedAt = messageDate;
							tm.status = messagesStatus.SENT; // Original message was sent already
							tm.u = tMessageRecord.u;
							tm.t = message.t;
							tm.attachments = tMessageRecord.attachments;
							if (message.t === E2E_MESSAGE_TYPE) {
								tm.e2e = E2E_STATUS.DONE as E2EType;
							}
						})
					);
				}

				// Create the message sent in ThreadMessages collection
				batch.push(
					threadMessagesCollection.prepareCreate(tm => {
						tm._raw = sanitizedRaw({ id: messageId }, threadMessagesCollection.schema);
						if (tm.subscription) {
							tm.subscription.id = rid;
						}
						tm.rid = tmid;
						tm.msg = msg;
						tm.ts = messageDate;
						tm._updatedAt = messageDate;
						tm.status = messagesStatus.TEMP;
						tm.u = {
							_id: user.id || '1',
							username: user.username,
							name: user.name
						};
						tm.t = message.t;
						if (message.t === E2E_MESSAGE_TYPE) {
							tm.e2e = E2E_STATUS.DONE as E2EType;
						}
					})
				);
			} catch (e) {
				log(e);
			}
		}

		// Create the message sent in Messages collection
		batch.push(
			msgCollection.prepareCreate(m => {
				m._raw = sanitizedRaw({ id: messageId }, msgCollection.schema);
				if (m.subscription) {
					m.subscription.id = rid;
				}
				m.msg = msg;
				m.ts = messageDate;
				m._updatedAt = messageDate;
				m.status = messagesStatus.TEMP;
				m.u = {
					_id: user.id || '1',
					username: user.username,
					name: user.name
				};
				if (tmid && tMessageRecord) {
					m.tmid = tmid;
					// m.tlm = messageDate; // I don't think this is necessary... leaving it commented just in case...
					m.tmsg = tMessageRecord.msg;
					m.tshow = tshow;
				}
				m.t = message.t;
				if (message.t === E2E_MESSAGE_TYPE) {
					m.e2e = E2E_STATUS.DONE as E2EType;
				}
			})
		);

		try {
			const room = await subsCollection.find(rid);
			if (room.draftMessage) {
				batch.push(
					room.prepareUpdate(r => {
						r.draftMessage = null;
					})
				);
			}
		} catch (e) {
			// Do nothing
		}

		try {
			await db.write(async () => {
				await db.batch(...batch);
			});
		} catch (e) {
			log(e);
			return;
		}

		await sendMessageCall(message);
	} catch (e) {
		log(e);
	}
}
