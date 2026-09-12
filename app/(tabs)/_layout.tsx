import { Tabs } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';

import { colors, typography } from '@/src/design/tokens';

type TabIconProps = {
  color: ColorValue;
  name: SymbolViewProps['name'];
};

function TabIcon({ color, name }: TabIconProps) {
  return <SymbolView name={name} tintColor={color} size={24} />;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand.primary,
        tabBarInactiveTintColor: colors.text.muted,
        tabBarHideOnKeyboard: true,
        tabBarLabelStyle: {
          fontSize: typography.size.caption,
          fontWeight: typography.weight.medium,
          marginTop: 2,
        },
        tabBarStyle: {
          backgroundColor: colors.surface.raised,
          borderTopColor: colors.border.subtle,
          paddingTop: 7,
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => (
            <TabIcon color={color} name={{ ios: 'house.fill', android: 'home', web: 'home' }} />
          ),
        }}
      />
      <Tabs.Screen
        name="scan"
        options={{
          title: 'Scan',
          tabBarIcon: ({ color }) => (
            <TabIcon
              color={color}
              name={{ ios: 'viewfinder', android: 'qr_code_scanner', web: 'qr_code_scanner' }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="products"
        options={{
          title: 'Products',
          tabBarIcon: ({ color }) => (
            <TabIcon
              color={color}
              name={{ ios: 'shippingbox.fill', android: 'inventory_2', web: 'inventory_2' }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: 'Alerts',
          tabBarIcon: ({ color }) => (
            <TabIcon
              color={color}
              name={{ ios: 'exclamationmark.triangle.fill', android: 'warning', web: 'warning' }}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => (
            <TabIcon
              color={color}
              name={{ ios: 'gearshape.fill', android: 'settings', web: 'settings' }}
            />
          ),
        }}
      />
    </Tabs>
  );
}
