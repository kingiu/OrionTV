import React from 'react';
import { Image, ImageProps, ImageSourcePropType } from 'react-native';
import Logger from './Logger';

const logger = Logger.withTag('ImageLoader');

// 定义图片源类型
export interface ImageSource { 
  uri: string; 
  width?: number; 
  height?: number; 
}

// 定义优化图片组件的属性接口
export interface OptimizedImageProps extends ImageProps {
  targetWidth?: number;
  targetHeight?: number;
  preload?: boolean;
  lazyLoad?: boolean;
}

// 生成图片缓存键的辅助函数
export const generateImageCacheKey = (url: string, width?: number, height?: number): string => {
  if (!url) return '';
  if (width && height) {
    return `${url}_${width}x${height}`;
  }
  return url;
};

/**
 * 优化的图片组件，使用React Native原生Image组件确保兼容性
 */
export const OptimizedImage: React.FC<OptimizedImageProps> = ({ 
  source, 
  style, 
  targetWidth,
  targetHeight,
  preload = false,
  ...restProps 
}) => {
  // 处理source对象 - 必须在所有条件语句之前调用hooks
  const processedSource = React.useMemo((): ImageSourcePropType => {
    if (typeof source === 'string') {
      // 支持直接传入字符串URL
      logger.debug('Processing string source URL');
      return { uri: source };
    } else if (typeof source === 'object' && source && 'uri' in source && source.uri) {
      logger.debug('Processing object source with URL');
      return { uri: source.uri };
    }
    logger.warn('Invalid source provided');
    return source as ImageSourcePropType;
  }, [source]);
  
  // 错误处理函数
  const handleError = React.useCallback((error: any) => {
    logger.error('Image loading failed:', error);
    if (restProps.onError) {
      restProps.onError(error);
    }
  }, [restProps.onError]);
  
  // 预加载模式下不渲染图片
  if (preload) {
    return null;
  }
  
  // 直接使用React Native的Image组件
  return React.createElement(
    Image,
    {
      source: processedSource,
      style: style,
      onError: handleError,
      ...restProps
    }
  );
};

/**
 * 预加载单张图片
 */
export const preloadImage = (url: string): void => {
  if (!url) return;
  
  try {
    logger.debug('Image preload requested');
  } catch (error) {
    logger.error('Error in preloadImage:', error);
  }
};

/**
 * 批量预加载图片
 */
export const preloadImages = (imageUrls: string[] | ImageSource[]): void => {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return;
  
  try {
    // 过滤出有效的图片源
    const validSources = imageUrls
      .filter(item => item != null)
      .map(item => {
        const uri = typeof item === 'string' ? item : (item && 'uri' in item ? item.uri : '');
        return uri ? { uri } : null;
      })
      .filter((item): item is { uri: string } => item != null);
    
    logger.debug(`Images preload requested: ${validSources.length}`);
  } catch (error) {
    logger.error('Error in preloadImages:', error);
  }
};

/**
 * 清除图片缓存
 */
export const clearImageCache = async (): Promise<void> => {
  try {
    logger.info('Image cache clearing requested');
  } catch (error) {
    logger.error('Error in clearImageCache:', error);
  }
};

// 导出类型供外部使用
export default OptimizedImage;

// 导出用于调试的函数
export const testImageLoading = (url?: string): { isURLValid: boolean; url?: string } => {
  logger.debug('Testing image URL');
  return {
    isURLValid: typeof url === 'string' && url.length > 0,
    url
  };
};