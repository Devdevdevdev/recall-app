import { SymbolView, type AndroidSymbol, type SFSymbol, type SymbolViewProps } from 'expo-symbols';

type AppIconProps = {
  color: SymbolViewProps['tintColor'];
  size?: number;
  ios: SFSymbol;
  android: AndroidSymbol;
};

export function AppIcon({ android, color, ios, size = 24 }: AppIconProps) {
  return (
    <SymbolView
      name={{ ios, android, web: android }}
      tintColor={color}
      size={size}
      resizeMode="scaleAspectFit"
    />
  );
}
