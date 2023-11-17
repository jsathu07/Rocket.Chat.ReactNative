import React, { useEffect, useState } from 'react';
import { StyleSheet, Alert } from 'react-native';
import RNDialog from 'react-native-dialog';

import EventEmitter from '../lib/methods/helpers/events';
import { Services } from '../lib/services';
import I18n from '../i18n';
import log, { logEvent } from '../lib/methods/helpers/log';
import events from '../lib/methods/helpers/log/events';
import { useTheme } from '../theme';
import sharedStyles from '../views/Styles';

const styles = StyleSheet.create({
	title: {
		fontSize: 18,
		...sharedStyles.textMedium
	},
	description: {
		fontSize: 15,
		...sharedStyles.textRegular
	},
	buttonText: {
		fontSize: 14,
		...sharedStyles.textSemibold
	}
});

export const LISTENER_DIALOG = 'Dialog';

let listener: Function;

interface IMessage {
	title: string;
	description: string;
	inputLabel: string;
	data: any;
}

const Dialog = (): React.ReactElement => {
	const { colors } = useTheme();

	const [isVisible, setIsVisible] = useState(false);
	const [text, setText] = useState('');
	const [dialog, setDialog] = useState<IMessage | null>(null);

	const reportMessage = async () => {
		try {
			await Services.reportMessage(dialog?.data?.id, text);
			Alert.alert(I18n.t('Message_Reported'));
		} catch (e) {
			logEvent(events.ROOM_MSG_ACTION_REPORT_F);
			log(e);
		} finally {
			handleCancel();
		}
	};

	const showDialog = (eventData: any) => {
		setIsVisible(true);
		setText('');
		setDialog(eventData.dialog);
	};

	const handleCancel = () => {
		setIsVisible(false);
		setText('');
		setDialog(null);
	};

	useEffect(() => {
		listener = EventEmitter.addEventListener(LISTENER_DIALOG, showDialog);
		return () => {
			EventEmitter.removeListener(LISTENER_DIALOG, listener);
		};
	}, []);

	return (
		<RNDialog.Container visible={isVisible}>
			<RNDialog.Title style={[styles.title, { color: colors.infoText }]}>{dialog?.title}</RNDialog.Title>
			<RNDialog.Description style={[styles.description, { color: colors.bodyText }]}>{dialog?.description}</RNDialog.Description>
			<RNDialog.Input label={dialog?.inputLabel} value={text} onChangeText={t => setText(t)} />
			<RNDialog.Button style={styles.buttonText} color={colors.cancelButton} label='Cancel' onPress={handleCancel} />
			<RNDialog.Button style={styles.buttonText} color={colors.dangerColor} label='Report!' onPress={reportMessage} />
		</RNDialog.Container>
	);
};

export default Dialog;
