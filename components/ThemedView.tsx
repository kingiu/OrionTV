import React from 'react';
import {View, ViewProps} from 'react-native';

import {useThemeColor} from '@/hooks/useThemeColor';

export interface ThemedViewProps extends ViewProps {
  lightColor?: string;
  darkColor?: string;
}

export const ThemedView: React.FC<ThemedViewProps> = ({
  style,
  lightColor,
  darkColor,
  ...otherProps
}) => {
  const backgroundColor = useThemeColor(
    {light: lightColor, dark: darkColor},
    'background',
  );

  return <View style={[{backgroundColor}, style]} {...otherProps} />;
};
