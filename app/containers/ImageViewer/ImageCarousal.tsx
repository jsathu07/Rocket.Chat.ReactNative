import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

import { ImageViewer } from './ImageViewer';

export interface ImageProps {
	imageComponentType?: string;
	width: number;
	height: number;
	onLoadEnd?: () => void;
}

export interface IImageData {
	uri: string;
	title?: string;
	image_type?: string;
}

interface ImageCarousalProps extends ImageProps {
	data: IImageData[];
	firstIndex: number;
	showHeader?: boolean;
}

export const ImageCarousal = ({
	data,
	firstIndex,
	width,
	height,
	showHeader = false,
	...props
}: ImageCarousalProps): React.ReactElement => {
	const WIDTH_OFFSET = -width;

	const currItem = useSharedValue(firstIndex);
	const translateOuterX = useSharedValue(WIDTH_OFFSET * currItem.value);
	const offsetOuterX = useSharedValue(WIDTH_OFFSET * currItem.value);

	const [curr, setCurr] = useState(firstIndex);

	const style = useAnimatedStyle(() => ({
		transform: [{ translateX: translateOuterX.value }]
	}));

	useAnimatedReaction(
		() => currItem.value,
		currVal => {
			runOnJS(setCurr)(currVal);
		}
	);

	return (
		<GestureHandlerRootView style={styles.container}>
			<View style={[{ width: data.length * width, height }]}>
				<Animated.View style={[{ flex: 1, flexDirection: 'row' }, style]}>
					{data.map((item: IImageData, index) => {
						if (index === curr || index === curr - 1 || index === curr + 1) {
							return (
								<ImageViewer
									key={item.uri}
									item={item}
									translateOuterX={translateOuterX}
									offsetOuterX={offsetOuterX}
									currItem={currItem}
									size={data.length}
									width={width}
									height={height}
									showHeader={showHeader}
									{...props}
								/>
							);
						}
						return <View key={item.uri} style={{ width, height }} />;
					})}
				</Animated.View>
			</View>
		</GestureHandlerRootView>
	);
};

const styles = StyleSheet.create({
	container: {
		flex: 1,
		justifyContent: 'center'
	}
});
