import { create } from "zustand";
import Toast from "react-native-toast-message";
import { AVPlaybackStatus, Video } from "expo-av";
import { RefObject } from "react";
import { PlayRecord, PlayRecordManager, PlayerSettingsManager } from "@/services/storage";
import useDetailStore, { episodesSelectorBySource } from "./detailStore";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('PlayerStore');

interface Episode {
  url: string;
  title: string;
}

interface PlayerState {
  videoRef: RefObject<Video> | null;
  currentEpisodeIndex: number;
  episodes: Episode[];
  status: AVPlaybackStatus | null;
  isLoading: boolean;
  showControls: boolean;
  showEpisodeModal: boolean;
  showSourceModal: boolean;
  showSpeedModal: boolean;
  showNextEpisodeOverlay: boolean;
  isSeeking: boolean;
  seekPosition: number;
  progressPosition: number;
  initialPosition: number;
  playbackRate: number;
  introEndTime?: number;
  outroStartTime?: number;
  // 新增字段：用于标记是否是用户手动暂停
  isUserPaused: boolean;
  setVideoRef: (ref: RefObject<Video>) => void;
  loadVideo: (options: {
    source: string;
    id: string;
    title: string;
    episodeIndex: number;
    position?: number;
  }) => Promise<void>;
  playEpisode: (index: number) => void;
  togglePlayPause: () => void;
  seek: (duration: number) => void;
  handlePlaybackStatusUpdate: (newStatus: AVPlaybackStatus) => void;
  setLoading: (loading: boolean) => void;
  setShowControls: (show: boolean) => void;
  setShowEpisodeModal: (show: boolean) => void;
  setShowSourceModal: (show: boolean) => void;
  setShowSpeedModal: (show: boolean) => void;
  setShowNextEpisodeOverlay: (show: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setIntroEndTime: () => void;
  setOutroStartTime: () => void;
  reset: () => void;
  _seekTimeout?: NodeJS.Timeout;
  _isRecordSaveThrottled: boolean;
  // Internal helper
  _savePlayRecord: (updates?: Partial<PlayRecord>, options?: { immediate?: boolean }) => void;
  handleVideoError: (errorType: 'ssl' | 'network' | 'other', failedUrl: string) => Promise<void>;
  // 新增字段：用于检测加载慢的状态
  _bufferingStartTime?: number;
  _bufferingTimeout?: NodeJS.Timeout;
  // 新增字段：用于缓冲重试计数
  _bufferingRetryCount: number;
  // 预加载相关字段
  _preloadingEpisode?: string;
  _preloadTestAbortController?: AbortController;
  // 预加载方法
  _preloadAndTestSource: (url: string) => Promise<boolean>;
  // 新增字段：记录快进操作时间
  _lastSeekTime?: number;
  // 新增字段：缓存的视频源
  _cachedSources: Map<string, { url: string, timestamp: number, responseTime: number }>;
}

const usePlayerStore = create<PlayerState>((set, get) => ({
  videoRef: null,
  episodes: [],
  currentEpisodeIndex: -1,
  status: null,
  isLoading: true,
  showControls: false,
  showEpisodeModal: false,
  showSourceModal: false,
  showSpeedModal: false,
  showNextEpisodeOverlay: false,
  isSeeking: false,
  seekPosition: 0,
  progressPosition: 0,
  initialPosition: 0,
  playbackRate: 1.0,
  introEndTime: undefined,
  outroStartTime: undefined,
  isUserPaused: false,
  _seekTimeout: undefined,
  _isRecordSaveThrottled: false,
  _bufferingStartTime: undefined,
  _bufferingTimeout: undefined,
  _bufferingRetryCount: 0,
  _preloadingEpisode: undefined,
  _preloadTestAbortController: undefined,
  _lastSeekTime: undefined,
  _cachedSources: new Map(),

  setVideoRef: (ref) => set({ videoRef: ref }),

  // 预加载并测试视频源的可用性和速度
  _preloadAndTestSource: async (url: string): Promise<boolean> => {
    const perfStart = performance.now();
    logger.info(`[PRELOAD] Testing source: ${url.substring(0, 100)}...`);
    
    // 检查缓存
    const currentState = get();
    const cacheKey = url;
    const cachedSource = currentState._cachedSources.get(cacheKey);
    const now = Date.now();
    
    // 如果缓存存在且在5分钟内有效，直接使用缓存
    if (cachedSource && (now - cachedSource.timestamp) < 5 * 60 * 1000) {
      logger.info(`[PRELOAD] Using cached source info for ${url.substring(0, 50)}... (${cachedSource.responseTime}ms)`);
      return cachedSource.responseTime < 3000;
    }
    
    // 如果之前有预加载测试，取消它
    if (currentState._preloadTestAbortController) {
      currentState._preloadTestAbortController.abort();
    }
    
    const controller = new AbortController();
    const { signal } = controller;
    set({ _preloadTestAbortController: controller });
    
    try {
      // 只预加载前几秒的数据，测试连接速度和可用性
      if (url.endsWith('.m3u8')) {
        logger.info(`[PRELOAD] Source is m3u8 format, testing with limited GET request`);
        
        // 对于m3u8格式，发送GET请求但限制响应大小，测试连接性
        const response = await Promise.race([
          fetch(url, {
            method: 'GET',
            signal,
            headers: {
              'Range': 'bytes=0-1023' // 只获取前1KB数据
            }
          }),
          new Promise<Response>((_, reject) => 
            setTimeout(() => reject(new Error('Preload timeout')), 7000) // 增加超时时间
          )
        ]);
        
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const perfEnd = performance.now();
        const responseTime = perfEnd - perfStart;
        logger.info(`[PRELOAD] m3u8 Source ${url.substring(0, 50)}... is available (${responseTime.toFixed(2)}ms)`);
        
        // 缓存结果
        set(state => ({
          _cachedSources: new Map(state._cachedSources).set(cacheKey, {
            url,
            timestamp: now,
            responseTime
          })
        }));
        
        return responseTime < 4000; // 为m3u8增加一些容忍度
      }
      
      // 对于非m3u8格式，优化预加载策略
      const response = await Promise.race([
        fetch(url, {
          method: 'GET', // 使用GET而不是HEAD，可以预加载部分内容
          signal,
          headers: {
            'Range': 'bytes=0-4095' // 预加载前4KB数据，有助于播放器快速开始播放
          }
        }),
        new Promise<Response>((_, reject) => 
          setTimeout(() => reject(new Error('Preload timeout')), 7000) // 增加超时时间
        )
      ]);
      
      if (!response.ok && response.status !== 206) {
        // 206 Partial Content 也是可接受的
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const perfEnd = performance.now();
      const responseTime = perfEnd - perfStart;
      logger.info(`[PRELOAD] Source ${url.substring(0, 50)}... is available (${responseTime.toFixed(2)}ms)`);
      
      // 缓存结果
      set(state => ({
        _cachedSources: new Map(state._cachedSources).set(cacheKey, {
          url,
          timestamp: now,
          responseTime
        })
      }));
      
      // 如果响应时间在可接受范围内，则认为源是良好的
      return responseTime < 4000; // 增加容忍度，从3秒到4秒
    } catch (error) {
      logger.warn(`[PRELOAD] Failed to preload ${url.substring(0, 50)}...: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return false;
    } finally {
      // 清理
      set({ _preloadTestAbortController: undefined });
    }
  },

  loadVideo: async ({ source, id, episodeIndex, position, title }) => {
    const perfStart = performance.now();
    logger.info(`[PERF] PlayerStore.loadVideo START - source: ${source}, id: ${id}, title: ${title}`);
    
    let detail = useDetailStore.getState().detail;
    let episodes: string[] = [];
    
    // 如果有detail，使用detail的source获取episodes；否则使用传入的source
    if (detail && detail.source) {
      logger.info(`[INFO] Using existing detail source "${detail.source}" to get episodes`);
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
    } else {
      logger.info(`[INFO] No existing detail, using provided source "${source}" to get episodes`);
      episodes = episodesSelectorBySource(source)(useDetailStore.getState());
    }

    set({
      isLoading: true,
    });

    const needsDetailInit = !detail || !episodes || episodes.length === 0 || detail.title !== title;
    logger.info(`[PERF] Detail check - needsInit: ${needsDetailInit}, hasDetail: ${!!detail}, episodesCount: ${episodes?.length || 0}`);

    if (needsDetailInit) {
      const detailInitStart = performance.now();
      logger.info(`[PERF] DetailStore.init START - ${title}`);
      
      await useDetailStore.getState().init(title, source, id);
      
      const detailInitEnd = performance.now();
      logger.info(`[PERF] DetailStore.init END - took ${(detailInitEnd - detailInitStart).toFixed(2)}ms`);
      
      detail = useDetailStore.getState().detail;
      
      if (!detail) {
        logger.error(`[ERROR] Detail not found after initialization for "${title}" (source: ${source}, id: ${id})`);
        
        // 检查DetailStore的错误状态
        const detailStoreState = useDetailStore.getState();
        if (detailStoreState.error) {
          logger.error(`[ERROR] DetailStore error: ${detailStoreState.error}`);
          set({ 
            isLoading: false,
            // 可以选择在这里设置一个错误状态，但playerStore可能没有error字段
          });
        } else {
          logger.error(`[ERROR] DetailStore init completed but no detail found and no error reported`);
          set({ isLoading: false });
        }
        return;
      }
      
      // 使用DetailStore找到的实际source来获取episodes，而不是原始的preferredSource
      logger.info(`[INFO] Using actual source "${detail.source}" instead of preferred source "${source}"`);  
      episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
      
      if (!episodes || episodes.length === 0) {
        logger.error(`[ERROR] No episodes found for "${title}" from source "${detail.source}" (${detail.source_name})`);
        
        // 尝试从searchResults中直接获取episodes
        const detailStoreState = useDetailStore.getState();
        logger.info(`[INFO] Available sources in searchResults: ${detailStoreState.searchResults.map(r => `${r.source}(${r.episodes?.length || 0} episodes)`).join(', ')}`);
        
        // 如果当前source没有episodes，尝试使用第一个有episodes的source
        const sourceWithEpisodes = detailStoreState.searchResults.find(r => r.episodes && r.episodes.length > 0);
        if (sourceWithEpisodes) {
          logger.info(`[FALLBACK] Using alternative source "${sourceWithEpisodes.source}" with ${sourceWithEpisodes.episodes.length} episodes`);
          episodes = sourceWithEpisodes.episodes;
          // 更新detail为有episodes的source
          detail = sourceWithEpisodes;
        } else {
          logger.error(`[ERROR] No source with episodes found in searchResults`);
          set({ isLoading: false });
          return;
        }
      }
      
      logger.info(`[SUCCESS] Detail and episodes loaded - source: ${detail.source_name}, episodes: ${episodes.length}`);
    } else {
      logger.info(`[PERF] Skipping DetailStore.init - using cached data`);
      
      // 即使是缓存的数据，也要确保使用正确的source获取episodes
      if (detail && detail.source && detail.source !== source) {
        logger.info(`[INFO] Cached detail source "${detail.source}" differs from provided source "${source}", updating episodes`);
        episodes = episodesSelectorBySource(detail.source)(useDetailStore.getState());
        
        if (!episodes || episodes.length === 0) {
          logger.warn(`[WARN] Cached detail source "${detail.source}" has no episodes, trying provided source "${source}"`);
          episodes = episodesSelectorBySource(source)(useDetailStore.getState());
        }
      }
    }

    // 最终验证：确保我们有有效的detail和episodes数据
    if (!detail) {
      logger.error(`[ERROR] Final check failed: detail is null`);
      set({ isLoading: false });
      return;
    }
    
    if (!episodes || episodes.length === 0) {
      logger.error(`[ERROR] Final check failed: no episodes available for source "${detail.source}" (${detail.source_name})`);
      set({ isLoading: false });
      return;
    }
    
    // 尝试预加载和测试当前源的可用性
    if (episodes.length > episodeIndex) {
      const episodeUrl = episodes[episodeIndex];
      logger.info(`[PERF] Preloading and testing source: ${episodeUrl.substring(0, 100)}...`);
      
      // 检查是否是当前正在预加载的集数，避免重复预加载
      if (get()._preloadingEpisode !== episodeUrl) {
        set({ _preloadingEpisode: episodeUrl });
        
        try {
          const isSourceGood = await get()._preloadAndTestSource(episodeUrl);
          
          // 如果预加载失败，尝试切换到下一个可用源
          if (!isSourceGood) {
            logger.warn(`[PRELOAD] Current source preload failed, trying to find better source`);
            
            // 获取下一个可用的源
            const fallbackSource = useDetailStore.getState().getNextAvailableSource(detail.source, episodeIndex);
            
            if (fallbackSource && fallbackSource.episodes && fallbackSource.episodes.length > episodeIndex) {
              const fallbackUrl = fallbackSource.episodes[episodeIndex];
              
              // 测试备用源
              const isFallbackGood = await get()._preloadAndTestSource(fallbackUrl);
              
              if (isFallbackGood) {
                logger.info(`[PRELOAD] Fallback source ${fallbackSource.source_name} is better, switching to it`);
                // 更新Detail为备用源
                await useDetailStore.getState().setDetail(fallbackSource);
                // 使用备用源的episodes
                episodes = fallbackSource.episodes;
                // 更新detail引用
                detail = fallbackSource;
                
                // 标记原始源为失败
                useDetailStore.getState().markSourceAsFailed(detail.source, 'preload_failed');
              }
            }
          }
          
          // 无论如何，都为下一集预加载，提升用户体验
          if (episodes.length > episodeIndex + 1) {
            const nextEpisodeUrl = episodes[episodeIndex + 1];
            logger.info(`[PERF] Preloading next episode: ${nextEpisodeUrl.substring(0, 100)}...`);
            
            // 异步预加载下一集，不阻塞当前流程
            setTimeout(async () => {
              // 确保用户仍在当前集数，才预加载下一集
              if (get().currentEpisodeIndex === episodeIndex) {
                await get()._preloadAndTestSource(nextEpisodeUrl);
              }
            }, 1000); // 延迟1秒开始预加载下一集，避免影响当前集数的加载
          }
        } catch (error) {
          logger.error(`[PRELOAD] Error during preload test:`, error);
        } finally {
          set({ _preloadingEpisode: undefined });
        }
      }
    }
    
    logger.info(`[SUCCESS] Final validation passed - detail: ${detail.source_name}, episodes: ${episodes.length}`);

    try {
      const storageStart = performance.now();
      logger.info(`[PERF] Storage operations START`);
      
      const playRecord = await PlayRecordManager.get(detail!.source, detail!.id.toString());
      const storagePlayRecordEnd = performance.now();
      logger.info(`[PERF] PlayRecordManager.get took ${(storagePlayRecordEnd - storageStart).toFixed(2)}ms`);
      
      const playerSettings = await PlayerSettingsManager.get(detail!.source, detail!.id.toString());
      const storageEnd = performance.now();
      logger.info(`[PERF] PlayerSettingsManager.get took ${(storageEnd - storagePlayRecordEnd).toFixed(2)}ms`);
      logger.info(`[PERF] Total storage operations took ${(storageEnd - storageStart).toFixed(2)}ms`);
      
      const initialPositionFromRecord = playRecord?.play_time ? playRecord.play_time * 1000 : 0;
      const savedPlaybackRate = playerSettings?.playbackRate || 1.0;
      
      const episodesMappingStart = performance.now();
      const mappedEpisodes = episodes.map((ep, index) => ({
        url: ep,
        title: `第 ${index + 1} 集`,
      }));
      const episodesMappingEnd = performance.now();
      logger.info(`[PERF] Episodes mapping (${episodes.length} episodes) took ${(episodesMappingEnd - episodesMappingStart).toFixed(2)}ms`);
      
      set({
        isLoading: false,
        currentEpisodeIndex: episodeIndex,
        initialPosition: position || initialPositionFromRecord,
        playbackRate: savedPlaybackRate,
        episodes: mappedEpisodes,
        introEndTime: playRecord?.introEndTime || playerSettings?.introEndTime,
        outroStartTime: playRecord?.outroStartTime || playerSettings?.outroStartTime,
      });
      
      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo COMPLETE - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
      
    } catch (error) {
      logger.debug("Failed to load play record", error);
      set({ isLoading: false });
      
      const perfEnd = performance.now();
      logger.info(`[PERF] PlayerStore.loadVideo ERROR - total time: ${(perfEnd - perfStart).toFixed(2)}ms`);
    }
  },

  playEpisode: async (index) => {
    const { episodes, videoRef } = get();
    if (index >= 0 && index < episodes.length) {
      set({
        currentEpisodeIndex: index,
        showNextEpisodeOverlay: false,
        initialPosition: 0,
        progressPosition: 0,
        seekPosition: 0,
      });
      try {
        await videoRef?.current?.replayAsync();
      } catch (error) {
        logger.debug("Failed to replay video:", error);
        Toast.show({ type: "error", text1: "播放失败" });
      }
    }
  },

  togglePlayPause: async () => {
    const { status, videoRef } = get();
    if (status?.isLoaded) {
      try {
        if (status.isPlaying) {
          await videoRef?.current?.pauseAsync();
          // 标记为用户手动暂停
          set({ isUserPaused: true });
        } else {
          await videoRef?.current?.playAsync();
          // 取消用户手动暂停标记
          set({ isUserPaused: false });
        }
      } catch (error) {
        logger.debug("Failed to toggle play/pause:", error);
        Toast.show({ type: "error", text1: "操作失败" });
      }
    }
  },

  seek: async (duration) => {
    const { status, videoRef } = get();
    if (!status?.isLoaded || !status.durationMillis) return;

    const newPosition = Math.max(0, Math.min(status.positionMillis + duration, status.durationMillis));
    try {
      await videoRef?.current?.setPositionAsync(newPosition);
      // 记录快进操作时间，用于后续缓冲检测
      set({ _lastSeekTime: Date.now() });
    } catch (error) {
      logger.debug("Failed to seek video:", error);
      Toast.show({ type: "error", text1: "快进/快退失败" });
    }

    set({
      isSeeking: true,
      seekPosition: newPosition / status.durationMillis,
    });

    if (get()._seekTimeout) {
      clearTimeout(get()._seekTimeout);
    }
    const timeoutId = setTimeout(() => set({ isSeeking: false }), 1000);
    set({ _seekTimeout: timeoutId });
  },

  setIntroEndTime: () => {
    const { status, introEndTime: existingIntroEndTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingIntroEndTime) {
      // Clear the time
      set({ introEndTime: undefined });
      get()._savePlayRecord({ introEndTime: undefined }, { immediate: true });
      Toast.show({
        type: "info",
        text1: "已清除片头时间",
      });
    } else {
      // Set the time
      const newIntroEndTime = status.positionMillis;
      set({ introEndTime: newIntroEndTime });
      get()._savePlayRecord({ introEndTime: newIntroEndTime }, { immediate: true });
      Toast.show({
        type: "success",
        text1: "设置成功",
        text2: "片头时间已记录。",
      });
    }
  },

  setOutroStartTime: () => {
    const { status, outroStartTime: existingOutroStartTime } = get();
    const detail = useDetailStore.getState().detail;
    if (!status?.isLoaded || !detail) return;

    if (existingOutroStartTime) {
      // Clear the time
      set({ outroStartTime: undefined });
      get()._savePlayRecord({ outroStartTime: undefined }, { immediate: true });
      Toast.show({
        type: "info",
        text1: "已清除片尾时间",
      });
    } else {
      // Set the time
      if (!status.durationMillis) return;
      const newOutroStartTime = status.durationMillis - status.positionMillis;
      set({ outroStartTime: newOutroStartTime });
      get()._savePlayRecord({ outroStartTime: newOutroStartTime }, { immediate: true });
      Toast.show({
        type: "success",
        text1: "设置成功",
        text2: "片尾时间已记录。",
      });
    }
  },

  _savePlayRecord: (updates = {}, options = {}) => {
    const { immediate = false } = options;
    if (!immediate) {
      if (get()._isRecordSaveThrottled) {
        return;
      }
      set({ _isRecordSaveThrottled: true });
      setTimeout(() => {
        set({ _isRecordSaveThrottled: false });
      }, 10000); // 10 seconds
    }

    const { detail } = useDetailStore.getState();
    const { currentEpisodeIndex, episodes, status, introEndTime, outroStartTime } = get();
    if (detail && status?.isLoaded) {
      const existingRecord = {
        introEndTime,
        outroStartTime,
      };
      PlayRecordManager.save(detail.source, detail.id.toString(), {
        title: detail.title,
        cover: detail.poster || "",
        index: currentEpisodeIndex + 1,
        total_episodes: episodes.length,
        play_time: Math.floor(status.positionMillis / 1000),
        total_time: status.durationMillis ? Math.floor(status.durationMillis / 1000) : 0,
        source_name: detail.source_name,
        year: detail.year || "",
        ...existingRecord,
        ...updates,
      });
    }
  },

  handlePlaybackStatusUpdate: (newStatus) => {
      const { _bufferingStartTime, _bufferingTimeout, currentEpisodeIndex, episodes, outroStartTime, playEpisode, _bufferingRetryCount, isUserPaused, _lastSeekTime } = get();
      const detail = useDetailStore.getState().detail;
      
      // 处理加载慢的情况：检测缓冲状态
      if (newStatus.isLoaded) {
        // 如果视频从暂停状态变为播放状态，取消用户手动暂停标记
        if (newStatus.isPlaying && isUserPaused) {
          set({ isUserPaused: false });
        }
        
        // 计算距离上次快进操作的时间
        const now = Date.now();
        const timeSinceLastSeek = _lastSeekTime ? now - _lastSeekTime : Infinity;
        const isRecentlySeeked = timeSinceLastSeek < 10000; // 10秒内认为是最近快进
        
        // 检测是否需要缓冲
        // 重要修改：
        // 1. 排除用户手动暂停的情况
        // 2. 排除最近快进操作后的缓冲
        // 3. 更精确地检测缓冲状态
        const isBuffering = newStatus.isLoaded && 
                           !newStatus.isPlaying && 
                           !isUserPaused &&
                           !isRecentlySeeked && // 最近快进后不进行缓冲超时检测
                           newStatus.positionMillis > 0 && 
                           (newStatus.durationMillis || 0) > 0 && 
                           newStatus.isBuffering;
        
        if (isBuffering) {
          // 如果是刚开始缓冲，记录开始时间
          if (!_bufferingStartTime) {
            logger.info(`[BUFFERING] Started at position: ${newStatus.positionMillis}ms`);
            set({ _bufferingStartTime: now, _bufferingRetryCount: 0 });
            
            // 设置超时，如果20秒还在缓冲且有明显卡顿，则认为加载慢并切换源
            // 增加缓冲超时阈值，减少不必要的源切换
            const timeoutId = setTimeout(() => {
              const currentState = get();
              const currentStatus = currentState.status;
              const currentTimeSinceLastSeek = currentState._lastSeekTime ? now - currentState._lastSeekTime : Infinity;
              const stillRecentlySeeked = currentTimeSinceLastSeek < 15000; // 检查是否仍然在快进后的窗口期
              
              // 更严格的判断条件：
              // 1. 确保状态仍然是加载中的
              // 2. 确保确实处于缓冲状态
              // 3. 确保重试次数不超过限制
              // 4. 确保不是用户手动暂停
              // 5. 确保不在快进后的窗口期
              if (currentStatus?.isLoaded && 
                  !currentStatus?.isPlaying && 
                  !currentState.isUserPaused &&
                  !stillRecentlySeeked &&
                  currentStatus?.positionMillis > 0 && 
                  currentStatus?.isBuffering && 
                  detail && 
                  currentState._bufferingRetryCount < 3) { // 增加重试次数到3次
                
                // 记录重试次数
                set({ _bufferingRetryCount: currentState._bufferingRetryCount + 1 });
                
                logger.warn(`[BUFFERING_TIMEOUT] Video buffering for too long (>20s), attempt ${currentState._bufferingRetryCount + 1}/3`);
                
                // 获取当前剧集
                const currentEpisode = currentState.episodes[currentEpisodeIndex];
                
                if (currentEpisode) {
                  // 根据重试次数决定操作
                  if (currentState._bufferingRetryCount === 0) {
                    logger.info(`[BUFFERING_RETRY] Retrying to buffer without switching source`);
                    // 尝试通过小幅度回退并重新播放来解决缓冲问题
                    if (currentStatus.positionMillis > 10000) { // 如果播放位置大于10秒
                      const newPosition = Math.max(0, currentStatus.positionMillis - 5000); // 回退5秒
                      currentState.videoRef?.current?.setPositionAsync(newPosition).catch(err => {
                        logger.warn(`[BUFFERING_RETRY] Failed to adjust position: ${err}`);
                      });
                    }
                  }
                  // 第二次尝试增加缓冲重试
                  else if (currentState._bufferingRetryCount === 1) {
                    logger.info(`[BUFFERING_RETRY] Second attempt to buffer without switching source`);
                    // 可以尝试降低播放质量或其他优化措施（如果播放器支持）
                  }
                  // 只有在第三次尝试仍然失败时才切换源
                  else if (currentState._bufferingRetryCount >= 2) {
                    logger.warn(`[BUFFERING_TIMEOUT] Multiple buffering attempts failed, switching source`);
                    // 使用网络错误类型来触发源切换
                    currentState.handleVideoError('network', currentEpisode.url);
                  }
                }
              }
            }, 20000); // 增加到20秒，减少不必要的切换
            
            set({ _bufferingTimeout: timeoutId });
          }
        } else {
          // 如果停止缓冲，清除记录的开始时间和超时
          if (_bufferingStartTime) {
            const bufferingDuration = now - _bufferingStartTime;
            logger.info(`[BUFFERING] Stopped after ${bufferingDuration}ms`);
            set({ _bufferingStartTime: undefined, _bufferingRetryCount: 0 });
          }
          
          if (_bufferingTimeout) {
            clearTimeout(_bufferingTimeout);
            set({ _bufferingTimeout: undefined });
          }
        }
      }
    
    if (!newStatus.isLoaded) {
      // 清除缓冲状态
      if (_bufferingTimeout) {
        clearTimeout(_bufferingTimeout);
        set({ _bufferingTimeout: undefined });
      }
      set({ _bufferingStartTime: undefined });
      
      if (newStatus.error) {
        logger.debug(`Playback Error: ${newStatus.error}`);
        // 如果有错误且有当前剧集，尝试切换源
        const currentEpisode = get().episodes[get().currentEpisodeIndex];
        if (currentEpisode && detail) {
          logger.warn(`[PLAYBACK_ERROR] Direct error detected, trying to switch source`);
          get().handleVideoError('other', currentEpisode.url);
        }
      }
      set({ status: newStatus });
      return;
    }

    if (
      outroStartTime &&
      newStatus.durationMillis &&
      newStatus.positionMillis >= newStatus.durationMillis - outroStartTime
    ) {
      if (currentEpisodeIndex < episodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
        return; // Stop further processing for this update
      }
    }

    if (detail && newStatus.durationMillis) {
      get()._savePlayRecord();

      const isNearEnd = newStatus.positionMillis / newStatus.durationMillis > 0.95;
      if (isNearEnd && currentEpisodeIndex < episodes.length - 1 && !outroStartTime) {
        set({ showNextEpisodeOverlay: true });
      } else {
        set({ showNextEpisodeOverlay: false });
      }
    }

    if (newStatus.didJustFinish) {
      if (currentEpisodeIndex < episodes.length - 1) {
        playEpisode(currentEpisodeIndex + 1);
      }
    }

    const progressPosition = newStatus.durationMillis && newStatus.positionMillis !== undefined ? newStatus.positionMillis / newStatus.durationMillis : 0;
    set({ status: newStatus, progressPosition });
  },

  setLoading: (loading) => set({ isLoading: loading }),
  setShowControls: (show) => set({ showControls: show }),
  setShowEpisodeModal: (show) => set({ showEpisodeModal: show }),
  setShowSourceModal: (show) => set({ showSourceModal: show }),
  setShowSpeedModal: (show) => set({ showSpeedModal: show }),
  setShowNextEpisodeOverlay: (show) => set({ showNextEpisodeOverlay: show }),

  setPlaybackRate: async (rate) => {
    const { videoRef } = get();
    const detail = useDetailStore.getState().detail;
    
    try {
      await videoRef?.current?.setRateAsync(rate, true);
      set({ playbackRate: rate });
      
      // Save the playback rate preference
      if (detail) {
        await PlayerSettingsManager.save(detail.source, detail.id.toString(), { playbackRate: rate });
      }
    } catch (error) {
      logger.debug("Failed to set playback rate:", error);
    }
  },

  reset: () => {
      // 清除所有超时定时器
      const currentState = get();
      if (currentState._seekTimeout) {
        clearTimeout(currentState._seekTimeout);
      }
      if (currentState._bufferingTimeout) {
        clearTimeout(currentState._bufferingTimeout);
      }
      if (currentState._preloadTestAbortController) {
        currentState._preloadTestAbortController.abort();
      }
      
      // 只保留缓存的源信息，其他状态重置
      const cachedSources = new Map(currentState._cachedSources);
      
      // 清理过期的缓存项（超过30分钟的缓存）
      const now = Date.now();
      cachedSources.forEach((value, key) => {
        if (now - value.timestamp > 30 * 60 * 1000) {
          cachedSources.delete(key);
        }
      });
      
      set({
        episodes: [],
        currentEpisodeIndex: 0,
        status: null,
        isLoading: true,
        showControls: false,
        showEpisodeModal: false,
        showSourceModal: false,
        showSpeedModal: false,
        showNextEpisodeOverlay: false,
        initialPosition: 0,
        playbackRate: 1.0,
        introEndTime: undefined,
        outroStartTime: undefined,
        isUserPaused: false,
        _seekTimeout: undefined,
        _bufferingTimeout: undefined,
        _bufferingStartTime: undefined,
        _bufferingRetryCount: 0,
        _preloadingEpisode: undefined,
        _preloadTestAbortController: undefined,
        _lastSeekTime: undefined,
        _cachedSources: cachedSources,
      });
    },

  handleVideoError: async (errorType: 'ssl' | 'network' | 'other', failedUrl: string) => {
    const perfStart = performance.now();
    logger.error(`[VIDEO_ERROR] Handling ${errorType} error for URL: ${failedUrl}`);
    
    const detailStoreState = useDetailStore.getState();
    const { detail } = detailStoreState;
    const { currentEpisodeIndex, status } = get();
    
    // 保存当前播放位置
    const currentPosition = status?.isLoaded && status?.positionMillis ? status.positionMillis : 0;
    
    if (!detail) {
      logger.error(`[VIDEO_ERROR] Cannot fallback - no detail available`);
      set({ isLoading: false });
      return;
    }
    
    // 标记当前source为失败
    const currentSource = detail.source;
    const errorReason = `${errorType} error: ${failedUrl.substring(0, 100)}...`;
    useDetailStore.getState().markSourceAsFailed(currentSource, errorReason);
    
    // 获取下一个可用的source
    const fallbackSource = useDetailStore.getState().getNextAvailableSource(currentSource, currentEpisodeIndex);
    
    if (!fallbackSource) {
      logger.error(`[VIDEO_ERROR] No fallback sources available for episode ${currentEpisodeIndex + 1}`);
      Toast.show({ 
        type: "error", 
        text1: "播放失败", 
        text2: "所有播放源都不可用，请稍后重试" 
      });
      set({ isLoading: false });
      return;
    }
    
    logger.info(`[VIDEO_ERROR] Switching to fallback source: ${fallbackSource.source} (${fallbackSource.source_name})`);
    
    try {
      // 更新DetailStore的当前detail为fallback source
      await useDetailStore.getState().setDetail(fallbackSource);
      
      // 重新加载当前集数的episodes
      const newEpisodes = fallbackSource.episodes || [];
      if (newEpisodes.length > currentEpisodeIndex) {
        const mappedEpisodes = newEpisodes.map((ep, index) => ({
          url: ep,
          title: `第 ${index + 1} 集`,
        }));
        
        set({
          episodes: mappedEpisodes,
          initialPosition: currentPosition, // 恢复到切换前的播放位置
          isLoading: false, // 让Video组件重新渲染
        });
        
        const perfEnd = performance.now();
        logger.info(`[VIDEO_ERROR] Successfully switched to fallback source in ${(perfEnd - perfStart).toFixed(2)}ms`);
        logger.info(`[VIDEO_ERROR] New episode URL: ${newEpisodes[currentEpisodeIndex].substring(0, 100)}...`);
        
        Toast.show({ 
          type: "success", 
          text1: "已切换播放源", 
          text2: `正在使用 ${fallbackSource.source_name}` 
        });
      } else {
        logger.error(`[VIDEO_ERROR] Fallback source doesn't have episode ${currentEpisodeIndex + 1}`);
        set({ isLoading: false });
      }
    } catch (error) {
      logger.error(`[VIDEO_ERROR] Failed to switch to fallback source:`, error);
      set({ isLoading: false });
    }
  },
}));

export default usePlayerStore;

export const selectCurrentEpisode = (state: PlayerState) => {
  // 增强数据安全性检查
  if (
    state.episodes &&
    Array.isArray(state.episodes) &&
    state.episodes.length > 0 &&
    state.currentEpisodeIndex >= 0 &&
    state.currentEpisodeIndex < state.episodes.length
  ) {
    const episode = state.episodes[state.currentEpisodeIndex];
    // 确保episode有有效的URL
    if (episode && episode.url && episode.url.trim() !== "") {
      return episode;
    } else {
      // 仅在调试模式下打印
      if (__DEV__) {
        logger.debug(`[PERF] selectCurrentEpisode - episode found but invalid URL: ${episode?.url}`);
      }
    }
  } else {
    // 仅在调试模式下打印
    if (__DEV__) {
      logger.debug(`[PERF] selectCurrentEpisode - no valid episode: episodes.length=${state.episodes?.length}, currentIndex=${state.currentEpisodeIndex}`);
    }
  }
  return undefined;
};
