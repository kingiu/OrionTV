// You can explore the built-in icon families and icons on the web at https://icons.expo.fyi/

import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {IconProps} from '@expo/vector-icons/build/createIconSet';
import {ComponentProps} from 'react';

export const TabBarIcon: React.FC<IconProps<ComponentProps<typeof Ionicons>['name']>> = ({
  style,
  ...rest
}) => {
  return <Ionicons size={28} style={[{marginBottom: -3}, style]} {...rest} />;
};
