import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { View, TextInput, StyleSheet, Alert, Keyboard, TouchableOpacity, ActivityIndicator, FlatList } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import VideoCard from "@/components/VideoCard";
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import { api, SearchResult } from "@/services/api";
import { Search, QrCode, X, RefreshCw } from "lucide-react-native";
import { StyledButton } from "@/components/StyledButton";
import { useRemoteControlStore } from "@/stores/remoteControlStore";
import { RemoteControlModal } from "@/components/RemoteControlModal";
import { useSettingsStore } from "@/stores/settingsStore";
import { useRouter } from "expo-router";
import { Colors } from "@/constants/Colors";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "@/utils/ResponsiveStyles";
import ResponsiveNavigation from "@/components/navigation/ResponsiveNavigation";
import ResponsiveHeader from "@/components/navigation/ResponsiveHeader";
import { DeviceUtils } from "@/utils/DeviceUtils";
import Logger from '@/utils/Logger';

const logger = Logger.withTag('SearchScreen');

// 搜索缓存接口
interface SearchCache {
  query: string;
  results: SearchResult[];
  total: number;
  timestamp: number;
}

// 缓存管理类 - 优化缓存策略
class SearchCacheManager {
  private cache: Map<string, SearchCache> = new Map();
  private maxCacheItems = 15; // 增加缓存数量
  private cacheTimeout = 10 * 60 * 1000; // 增加缓存时间到10分钟
  
  // 添加模糊匹配缓存查找
  findSimilarCache(query: string): SearchCache | null {
    const lowerQuery = query.toLowerCase();
    // 优先查找精确匹配
    const exactCache = this.get(query);
    if (exactCache) return exactCache;
    
    // 查找可能的相似查询缓存
    for (const [cachedQuery, cachedData] of this.cache.entries()) {
      // 如果查询包含缓存关键词或缓存关键词包含查询，考虑为相似查询
      if (Date.now() - cachedData.timestamp < this.cacheTimeout &&
          (lowerQuery.includes(cachedQuery.toLowerCase()) || 
           cachedQuery.toLowerCase().includes(lowerQuery))) {
        return cachedData;
      }
    }
    return null;
  }

  get(query: string): SearchCache | null {
    const cached = this.cache.get(query);
    if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
      return cached;
    }
    // 缓存过期，删除
    if (cached) {
      this.cache.delete(query);
    }
    return null;
  }

  set(query: string, results: SearchResult[], total: number): void {
    if (this.cache.size >= this.maxCacheItems) {
      // 删除最早的缓存项 - 添加类型安全检查
      const oldestKeyResult = this.cache.keys().next();
      if (!oldestKeyResult.done && typeof oldestKeyResult.value === 'string') {
        this.cache.delete(oldestKeyResult.value);
      }
    }
    this.cache.set(query, {
      query,
      results,
      total,
      timestamp: Date.now(),
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

// 全局缓存实例
const cacheManager = new SearchCacheManager();

export default function SearchScreen() {
  const [keyword, setKeyword] = useState<string>("");
  const [results, setResults] = useState<Array<SearchResult>>([]);
  const [totalResults, setTotalResults] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [isNewSearch, setIsNewSearch] = useState<boolean>(true);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchAbortController, setSearchAbortController] = useState<AbortController | null>(null);
  const [searchStartTime, setSearchStartTime] = useState<number>(0); // 记录搜索开始时间
  const [isCancelling, setIsCancelling] = useState<boolean>(false); // 取消状态标记
  const textInputRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList>(null);
  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);
  const { showModal: showRemoteModal, lastMessage, targetPage, clearMessage } = useRemoteControlStore();
  const { remoteInputEnabled } = useSettingsStore();
  const router = useRouter();

  // 响应式布局配置
  const responsiveConfig = useResponsiveLayout();
  const commonStyles = getCommonResponsiveStyles(responsiveConfig);
  const { deviceType, spacing } = responsiveConfig;

  // 页面大小配置 - 增加初始页面大小以减少加载更多的频率
  const pageSize = 30;

  useEffect(() => {
    if (lastMessage && targetPage === 'search') {
      logger.debug("Received remote input:", lastMessage);
      const realMessage = lastMessage.split("_")[0];
      setKeyword(realMessage);
      handleSearch(realMessage);
      clearMessage(); // Clear the message after processing
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastMessage, targetPage]);

  // 重置搜索状态
  const resetSearchState = useCallback(() => {
    setResults([]);
    setTotalResults(0);
    setCurrentPage(1);
    setHasMore(false);
    setError(null);
    setIsNewSearch(true);
    setIsCancelling(false);
  }, []);

  // 防抖函数
  const debounce = (func: Function, wait: number) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return function executedFunction(...args: any[]) {
      const later = () => {
        timeout = null;
        func(...args);
      };
      if (timeout !== null) {
        clearTimeout(timeout);
      }
      timeout = setTimeout(later, wait);
    };
  };

  // 取消当前搜索请求 - 增强版
  const cancelSearch = useCallback(() => {
    if (searchAbortController && !isCancelling) {
      logger.debug("Cancelling current search request");
      setIsCancelling(true);
      try {
        searchAbortController.abort();
      } catch (err) {
        logger.error("Error aborting search:", err);
      }
      setSearchAbortController(null);
      setLoading(false);
      setLoadingMore(false);
      setError("搜索已取消");
      setIsCancelling(false);
    }
  }, [searchAbortController, isCancelling]);
  
  // 搜索实现 - 优化版本
  const performSearch = async (searchText?: string, pageNum: number = 1) => {
    // 取消之前的搜索请求（如果有）
    if (searchAbortController) {
      try {
        searchAbortController.abort();
        setSearchAbortController(null);
      } catch (err) {
        logger.error("Error aborting previous search:", err);
      }
    }
    
    // 创建新的AbortController
    const abortController = new AbortController();
    setSearchAbortController(abortController);
    setIsCancelling(false);
    
    const term = typeof searchText === "string" ? searchText : keyword;
    // 确保term是有效的非空字符串
    const normalizedTerm = (term || '').trim();
    
    if (!normalizedTerm) {
      Keyboard.dismiss();
      return;
    }
    
    // 设置当前搜索关键词
    if (pageNum === 1) {
      setSearchQuery(normalizedTerm);
      setSearchStartTime(Date.now()); // 记录开始时间
    }
    
    Keyboard.dismiss();
    
    // 检查是否是新搜索或加载更多
    if (pageNum === 1) {
      setLoading(true);
      // 检查缓存 - 使用增强的相似缓存查找
      const cached = cacheManager.findSimilarCache(normalizedTerm);
      if (cached) {
        logger.debug("Using cached search results for:", normalizedTerm);
        // 对缓存结果进行排序
        const sortedResults = sortSearchResults([...cached.results], normalizedTerm);
        setResults(sortedResults);
        setTotalResults(cached.total);
        setHasMore(cached.total > sortedResults.length);
        setLoading(false);
        setIsNewSearch(false);
        setSearchAbortController(null);
        return;
      }
    } else {
      setLoadingMore(true);
    }
    
    setError(null);
    
    try {
      // 分离API调用和结果处理，允许设置不同的超时策略
      // 为冷门影片搜索设置更灵活的超时处理
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      
      // 添加搜索进度更新
      const updateSearchProgress = () => {
        const elapsed = Date.now() - searchStartTime;
        // 如果搜索时间超过3秒且仍在加载中，显示进度提示
        if (elapsed > 3000 && loading && isNewSearch) {
          // 可以在这里添加进度提示更新
          logger.info(`Search in progress for ${elapsed}ms`);
        }
      };
      
      // 设置定期检查进度
      const progressInterval = setInterval(updateSearchProgress, 1000);
      
      // 为API调用设置超时处理
      const searchPromise = api.searchVideos(
        normalizedTerm, 
        abortController.signal, 
        10000, // 稍微增加超时时间到10秒，但添加更好的用户反馈
        pageNum, 
        pageSize
      );
      
      // 添加搜索进度监控
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error('搜索请求超时，正在尝试获取部分结果...'));
        }, 7000); // 先于最终超时显示友好提示
      });
      
      // 直接使用try-catch处理搜索请求，避免Promise.race可能导致的问题
      let response;
      try {
        response = await Promise.race([searchPromise, timeoutPromise]);
      } catch (timeoutError) {
        // 超时后仍然尝试等待原始搜索请求完成，但不再显示错误
        logger.info("Search timeout warning, continuing with original request");
        // 不抛出错误，继续等待原始请求
        response = await searchPromise;
      }
      
      // 清除定时器
      if (timeoutId) clearTimeout(timeoutId);
      clearInterval(progressInterval);
      
      // 确保response存在且有results属性
      if (response && response.results) {
        // 对搜索结果进行排序
        const sortedResults = sortSearchResults([...response.results], normalizedTerm);
        
        if (pageNum === 1) {
          // 首次搜索，保存到缓存 - 只传递有效的非空字符串
          cacheManager.set(normalizedTerm, sortedResults, response.total || 0);
          // 立即显示前10个结果，然后异步添加剩余结果
          const initialResults = sortedResults.slice(0, 10);
          setResults(initialResults);
          
          // 异步添加剩余结果，改善用户体验
          setTimeout(() => {
            setResults(sortedResults);
          }, 100);
        } else {
          // 加载更多，追加到现有结果
          setResults(prev => [...prev, ...sortedResults]);
        }
        
        setTotalResults(response.total || 0);
        setHasMore(results.length + sortedResults.length < (response.total || 0));
        setCurrentPage(pageNum);
      } else if (pageNum === 1) {
        setError("没有找到相关内容");
      }
    } catch (err) {
      // 清除定时器
      if (timeoutId) clearTimeout(timeoutId);
      clearInterval(progressInterval);
      
      // 不处理人为取消的错误
      if (err instanceof Error && err.name === 'AbortError') {
        logger.info("Search was cancelled by user");
        return;
      }
      
      let errorMessage = "搜索失败，请稍后重试。";
      
      if (err instanceof Error) {
        if (err.message.includes('超时')) {
          errorMessage = "搜索请求超时，点击重试或取消搜索";
        } else if (err.message.includes('API基础URL未设置')) {
          errorMessage = "API服务器地址未配置，请先在设置页面配置服务器地址";
        } else {
          errorMessage = `搜索失败: ${err.message}`;
        }
      }
      
      setError(errorMessage);
      logger.info("Search failed:", err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setIsNewSearch(false);
      setSearchAbortController(null);
      setIsCancelling(false);
    }
  };
  
  // 搜索结果排序函数 - 优化匹配算法
  const sortSearchResults = useCallback((results: SearchResult[], term: string) => {
    const termLower = term.toLowerCase();
    return results.sort((a, b) => {
      const titleALower = a.title.toLowerCase();
      const titleBLower = b.title.toLowerCase();
      
      // 1. 完全匹配的排在最前面
      const aExactMatch = titleALower === termLower;
      const bExactMatch = titleBLower === termLower;
      if (aExactMatch && !bExactMatch) return -1;
      if (!aExactMatch && bExactMatch) return 1;
      
      // 2. 标题开头匹配的排在前面
      const aStartsWith = titleALower.startsWith(termLower);
      const bStartsWith = titleBLower.startsWith(termLower);
      if (aStartsWith && !bStartsWith) return -1;
      if (!aStartsWith && bStartsWith) return 1;
      
      // 3. 标题包含关键词的排在前面
      const aIncludes = titleALower.includes(termLower);
      const bIncludes = titleBLower.includes(termLower);
      if (aIncludes && !bIncludes) return -1;
      if (!aIncludes && bIncludes) return 1;
      
      // 4. 关键词在标题中位置靠前的排在前面
      const aIndex = titleALower.indexOf(termLower);
      const bIndex = titleBLower.indexOf(termLower);
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      
      // 5. 新增: 计算匹配度评分，优先显示匹配度高的结果
      const getMatchScore = (title: string) => {
        let score = 0;
        // 完全匹配分数
        if (title === termLower) score += 100;
        // 开头匹配分数
        else if (title.startsWith(termLower)) score += 80;
        // 包含匹配分数
        else if (title.includes(termLower)) score += 60;
        // 长度相似性评分 (较短的标题优先级略高)
        score -= Math.abs(title.length - termLower.length) * 0.1;
        return score;
      };
      
      const scoreA = getMatchScore(titleALower);
      const scoreB = getMatchScore(titleBLower);
      
      if (scoreA !== scoreB) {
        return scoreB - scoreA; // 降序排列，分数高的在前
      }
      
      // 6. 默认按原始顺序
      return 0;
    });
  }, []);

  // 创建防抖版本的搜索函数
  const debouncedSearch = useCallback(debounce(() => {
    if (keyword.trim()) {
      resetSearchState();
      performSearch(keyword, 1);
    }
  }, 600), [keyword, resetSearchState]); // 稍微增加防抖时间以减少不必要的请求
  
  // 处理搜索 - 优化快速连续搜索的处理
  const handleSearch = (searchText?: string) => {
    const term = searchText || keyword;
    if (term.trim()) {
      // 重置状态，但保留取消状态标记
      const wasCancelling = isCancelling;
      resetSearchState();
      if (wasCancelling) {
        setIsCancelling(true);
      }
      performSearch(term, 1);
    }
  };

  const onSearchPress = () => handleSearch();
  
  // 加载更多 - 增加错误处理
  const loadMore = () => {
    if (!loadingMore && hasMore && !loading && !isCancelling) {
      performSearch(searchQuery, currentPage + 1);
    }
  };
  
  // 渲染底部加载器
  const renderFooter = () => {
    if (!loadingMore) return null;
    return (
      <View style={[commonStyles.center, { paddingVertical: spacing }]}>
        <ActivityIndicator size="small" color={Colors.dark.primary} />
        <ThemedText style={{ marginTop: spacing / 2 }}>加载更多...</ThemedText>
      </View>
    );
  };

  const handleQrPress = () => {
    if (!remoteInputEnabled) {
      Alert.alert("远程输入未启用", "请先在设置页面中启用远程输入功能", [
        { text: "取消", style: "cancel" },
        { text: "去设置", onPress: () => router.push("/settings") },
      ]);
      return;
    }
    showRemoteModal('search');
  };

  // 渲染单个项目 - 优化懒加载和渲染性能
  const renderItem = ({ item, index }: { item: SearchResult; index: number }) => (
    <VideoCard
      id={item.id.toString()}
      source={item.source}
      title={item.title}
      poster={item.poster}
      year={item.year}
      sourceName={item.source_name}
      api={api}
      // 优化懒加载策略，根据设备类型调整阈值
      lazyLoad={index > (deviceType === 'mobile' ? 3 : deviceType === 'tablet' ? 5 : 8)}
      imageWidth={deviceType === 'tv' ? 200 : deviceType === 'tablet' ? 160 : 120}
      // 增加性能优化参数
      optimizeRender={true}
    />
  );

  // 动态样式
  const dynamicStyles = createResponsiveStyles(deviceType, spacing);

  const renderSearchContent = () => (
    <>
      <View style={dynamicStyles.searchContainer}>
        <TouchableOpacity
          activeOpacity={1}
          style={[
            dynamicStyles.inputContainer,
            {
              borderColor: isInputFocused ? Colors.dark.primary : "transparent",
            },
          ]}
          onPress={() => textInputRef.current?.focus()}
        >
          <TextInput
            ref={textInputRef}
            style={dynamicStyles.input}
            placeholder="搜索电影、剧集..."
            placeholderTextColor="#888"
            value={keyword}
            onChangeText={(text) => {
              setKeyword(text);
              // 当用户输入时使用防抖搜索
              debouncedSearch();
            }}
            onSubmitEditing={onSearchPress}
            onFocus={() => setIsInputFocused(true)}
            onBlur={() => setIsInputFocused(false)}
            returnKeyType="search"
            clearButtonMode="while-editing" // 添加清除按钮
          />
        </TouchableOpacity>
        <StyledButton style={dynamicStyles.searchButton} onPress={onSearchPress as any}>
          {loading && isNewSearch ? (
            <RefreshCw size={deviceType === 'mobile' ? 20 : 24} color="white" />
          ) : (
            <Search size={deviceType === 'mobile' ? 20 : 24} color="white" />
          )}
        </StyledButton>
        {deviceType !== 'mobile' && (
          <StyledButton style={dynamicStyles.qrButton} onPress={handleQrPress as any}>
            <QrCode size={deviceType === 'tv' ? 24 : 20} color="white" />
          </StyledButton>
        )}
      </View>

      {loading && isNewSearch ? (
        <View style={[commonStyles.center, { flex: 1 }]}>
          <VideoLoadingAnimation showProgressBar={true} />
          <TouchableOpacity 
            style={[dynamicStyles.cancelButton, { marginTop: spacing }]}
            onPress={cancelSearch}
          >
            <ThemedText style={{ color: Colors.dark.primary }}>取消搜索</ThemedText>
          </TouchableOpacity>
          <ThemedText style={{ marginTop: spacing / 2, color: Colors.dark.textSecondary }}>
            搜索可能需要一些时间，请稍候...
          </ThemedText>
        </View>
      ) : error ? (
        <View style={[commonStyles.center, { flex: 1 }]}>
          <ThemedText style={dynamicStyles.errorText}>{error}</ThemedText>
          {error.includes('API服务器地址') && (
            <StyledButton 
              onPress={() => router.push('/settings')}
              style={{ marginTop: spacing }}
            >
              前往设置
            </StyledButton>
          )}
          {(error.includes('超时') || error.includes('失败') || error.includes('取消')) && (
            <View style={{ flexDirection: 'row', marginTop: spacing, gap: spacing }}>
              <StyledButton 
                onPress={() => handleSearch()}
                style={{ flex: 1 }}
              >
                重试搜索
              </StyledButton>
            </View>
          )}
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={results}
          renderItem={renderItem}
          keyExtractor={(item) => `${item.id}-${item.source}`}
          contentContainerStyle={[
            results.length === 0 && !loading ? commonStyles.center : null,
            { flexGrow: 1, paddingBottom: spacing }
          ]}
          numColumns={deviceType === 'mobile' ? 3 : deviceType === 'tablet' ? 4 : 6}
          columnWrapperStyle={deviceType !== 'mobile' ? { justifyContent: 'space-between' } : null}
          showsVerticalScrollIndicator={false}
          onEndReached={loadMore}
          onEndReachedThreshold={0.2} // 降低阈值，提前加载更多
          ListFooterComponent={renderFooter}
          ListEmptyComponent={
            !loading ? (
              <ThemedText style={dynamicStyles.emptyText}>输入关键词开始搜索</ThemedText>
            ) : null
          }
          // 优化FlatList性能参数
          maxToRenderPerBatch={8} // 增加渲染批次数量
          windowSize={5} // 增加窗口大小
          removeClippedSubviews={true}
          initialNumToRender={12} // 增加初始渲染数量
          maxToRenderPerBatch={8}
          windowSize={5}
          updateCellsBatchingPeriod={100} // 优化更新批次周期
          // 添加getItemLayout提升滚动性能
          getItemLayout={(data, index) => ({
            length: deviceType === 'mobile' ? 180 : deviceType === 'tablet' ? 220 : 260,
            offset: (deviceType === 'mobile' ? 180 : deviceType === 'tablet' ? 220 : 260) * 
                   Math.floor(index / (deviceType === 'mobile' ? 3 : deviceType === 'tablet' ? 4 : 6)),
            index
          })}
          // 添加性能优化属性
          initialScrollIndex={null}
          scrollEventThrottle={16}
        />
      )}
      <RemoteControlModal />
    </>
  );

  const content = (
    <ThemedView style={[commonStyles.container, dynamicStyles.container]}>
      {renderSearchContent()}
    </ThemedView>
  );

  // 根据设备类型决定是否包装在响应式导航中
  if (deviceType === 'tv') {
    return content;
  }

  return (
    <ResponsiveNavigation>
      <ResponsiveHeader title="搜索" showBackButton />
      {content}
    </ResponsiveNavigation>
  );
}

const createResponsiveStyles = (deviceType: string, spacing: number) => {
  const isMobile = deviceType === 'mobile';
  const minTouchTarget = DeviceUtils.getMinTouchTargetSize();

  return StyleSheet.create({
    container: {
      flex: 1,
      paddingTop: deviceType === 'tv' ? 50 : 0,
    },
    searchContainer: {
      flexDirection: "row",
      paddingHorizontal: spacing,
      marginBottom: spacing,
      alignItems: "center",
      paddingTop: isMobile ? spacing / 2 : 0,
    },
    inputContainer: {
      flex: 1,
      height: isMobile ? minTouchTarget : 50,
      backgroundColor: "#2c2c2e",
      borderRadius: isMobile ? 8 : 8,
      marginRight: spacing / 2,
      borderWidth: 2,
      borderColor: "transparent",
      justifyContent: "center",
    },
    input: {
      flex: 1,
      paddingHorizontal: spacing,
      color: "white",
      fontSize: isMobile ? 16 : 18,
    },
    searchButton: {
      width: isMobile ? minTouchTarget : 50,
      height: isMobile ? minTouchTarget : 50,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: isMobile ? 8 : 8,
      marginRight: deviceType !== 'mobile' ? spacing / 2 : 0,
    },
    qrButton: {
      width: isMobile ? minTouchTarget : 50,
      height: isMobile ? minTouchTarget : 50,
      justifyContent: "center",
      alignItems: "center",
      borderRadius: isMobile ? 8 : 8,
    },
    cancelButton: {
      paddingHorizontal: spacing * 2,
      paddingVertical: spacing,
      borderRadius: 8,
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
    },
    errorText: {
      color: "red",
      fontSize: isMobile ? 16 : 18,
      textAlign: 'center',
    },
    emptyText: {
      fontSize: isMobile ? 16 : 18,
      color: Colors.dark.text,
    },
    footerText: {
      fontSize: isMobile ? 14 : 16,
      color: Colors.dark.text,
      textAlign: 'center',
      padding: spacing,
    }
  });
};
