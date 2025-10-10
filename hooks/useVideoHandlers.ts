import { useCallback, useMemo, useRef, RefObject } from 'react';
import { Video, ResizeMode } from 'expo-av';
import Toast from 'react-native-toast-message';
import usePlayerStore from '@/stores/playerStore';

// 为了支持NodeJS.Timeout类型
declare global {
  namespace NodeJS {
    interface Timeout {}
  }
}

interface UseVideoHandlersProps {
  videoRef: RefObject<Video>;
  currentEpisode: { url: string; title: string } | undefined;
  initialPosition: number;
  introEndTime?: number;
  playbackRate: number;
  handlePlaybackStatusUpdate: (status: any) => void;
  deviceType: string;
  detail?: { poster?: string };
}

export const useVideoHandlers = ({
  videoRef,
  currentEpisode,
  initialPosition,
  introEndTime,
  playbackRate,
  handlePlaybackStatusUpdate,
  deviceType,
  detail,
}: UseVideoHandlersProps) => {
  
  const onLoad = useCallback(async () => {
    console.info(`[PERF] Video onLoad - video ready to play`);
    
    try {
      // 1. 先设置位置（如果需要）
      const jumpPosition = initialPosition || introEndTime || 0;
      if (jumpPosition > 0) {
        console.info(`[PERF] Setting initial position to ${jumpPosition}ms`);
        await videoRef.current?.setPositionAsync(jumpPosition);
      }
      
      // 2. 显式调用播放以确保自动播放
      console.info(`[AUTOPLAY] Attempting to start playback after onLoad`);
      await videoRef.current?.playAsync();
      console.info(`[AUTOPLAY] Auto-play successful after onLoad`);
      
      usePlayerStore.setState({ isLoading: false });
      console.info(`[PERF] Video loading complete - isLoading set to false`);
    } catch (error) {
      console.warn(`[AUTOPLAY] Failed to auto-play after onLoad:`, error);
      // 即使自动播放失败，也要设置加载完成状态
      usePlayerStore.setState({ isLoading: false });
      // 不显示错误提示，因为自动播放失败是常见且预期的情况
    }
  }, [videoRef, initialPosition, introEndTime]);

  const onLoadStart = useCallback(() => {
    if (!currentEpisode?.url) return;
    
    console.info(`[PERF] Video onLoadStart - starting to load video: ${currentEpisode.url.substring(0, 100)}...`);
    usePlayerStore.setState({ isLoading: true });
  }, [currentEpisode?.url]);

  // 错误重试计数和定时器
  const retryCountRef = useRef<Record<string, number>>({});
  const lastErrorTimeRef = useRef<Record<string, number>>({});
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);

  const onError = useCallback(async (error: any) => {
    if (!currentEpisode?.url) return;
    
    console.error(`[ERROR] Video playback error:`, error);
    
    // 检测SSL证书错误和其他网络错误
    const errorString = (error as any)?.error?.toString() || error?.toString() || '';
    const isSSLError = errorString.includes('SSLHandshakeException') || 
                      errorString.includes('CertPathValidatorException') ||
                      errorString.includes('Trust anchor for certification path not found');
    const isNetworkError = errorString.includes('HttpDataSourceException') ||
                         errorString.includes('IOException') ||
                         errorString.includes('SocketTimeoutException');
    const errorType = isSSLError ? 'ssl' : isNetworkError ? 'network' : 'other';
    
    // 获取当前URL的重试计数
    const urlKey = currentEpisode.url.substring(0, 50); // 使用URL的前50个字符作为键
    retryCountRef.current[urlKey] = (retryCountRef.current[urlKey] || 0) + 1;
    const currentRetries = retryCountRef.current[urlKey];
    const lastErrorTime = lastErrorTimeRef.current[urlKey] || 0;
    const currentTime = Date.now();
    lastErrorTimeRef.current[urlKey] = currentTime;
    
    // 如果距离上次错误不到3秒，不显示弹窗（防抖）
    const showToast = currentTime - lastErrorTime > 3000;
    
    // 清除之前的重试定时器
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
    }
    
    // 最多重试2次
    if (currentRetries <= 2) {
      console.info(`[RETRY] Attempting to retry video playback (${currentRetries}/2) for URL: ${urlKey}...`);
      
      // 延迟重试，避免立即重试导致的快速失败
      retryTimerRef.current = setTimeout(async () => {
        try {
          // 尝试重置并重新加载视频
          if (videoRef.current) {
            await videoRef.current.unloadAsync();
            await videoRef.current.loadAsync({ uri: currentEpisode.url }, {}, false);
            await videoRef.current.playAsync();
            console.info(`[RETRY] Successfully reloaded video`);
          }
        } catch (retryError) {
          console.error(`[RETRY] Failed to reload video, attempting fallback source:`, retryError);
          usePlayerStore.getState().handleVideoError(errorType, currentEpisode.url);
        }
      }, 1000);
      
      // 只有在第一次错误时显示提示
      if (currentRetries === 1 && showToast) {
        let errorTitle = "视频播放问题";
        let errorMessage = "正在尝试修复...";
        
        if (isSSLError) errorTitle = "证书验证问题";
        else if (isNetworkError) errorTitle = "网络连接问题";
        
        Toast.show({ 
          type: "info", 
          text1: errorTitle, 
          text2: errorMessage,
          visibilityTime: 2000 // 减少提示显示时间
        });
      }
    } else {
      // 超过重试次数，切换到其他源
      console.error(`[FALLBACK] All retries failed, switching to fallback source for URL: ${urlKey}...`);
      
      // 重置此URL的重试计数
      delete retryCountRef.current[urlKey];
      
      // 只在必要时显示错误提示
      if (showToast) {
        let errorTitle = "播放失败";
        let errorMessage = "正在尝试其他播放源...";
        
        if (isSSLError) {
          errorTitle = "SSL证书错误";
        } else if (isNetworkError) {
          errorTitle = "网络连接失败";
        }
        
        Toast.show({ 
          type: "error", 
          text1: errorTitle, 
          text2: errorMessage,
          visibilityTime: 2000 // 减少提示显示时间
        });
      }
      
      usePlayerStore.getState().handleVideoError(errorType, currentEpisode.url);
    }
  }, [currentEpisode?.url, videoRef]);

  // 优化的Video组件props
  const videoProps = useMemo(() => ({
    source: { uri: currentEpisode?.url || '' },
    posterSource: { uri: detail?.poster ?? "" },
    resizeMode: ResizeMode.CONTAIN,
    rate: playbackRate,
    onPlaybackStatusUpdate: handlePlaybackStatusUpdate,
    onLoad,
    onLoadStart,
    onError,
    useNativeControls: deviceType !== 'tv',
    shouldPlay: true,
  }), [
    currentEpisode?.url,
    detail?.poster,
    playbackRate,
    handlePlaybackStatusUpdate,
    onLoad,
    onLoadStart,
    onError,
    deviceType,
  ]);

  return {
    onLoad,
    onLoadStart,
    onError,
    videoProps,
  };
};