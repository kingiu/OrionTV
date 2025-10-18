import React, { useState, useRef, useEffect, useCallback, useMemo, useCallback as useReactCallback } from "react";
import { View, TextInput, StyleSheet, Alert, Keyboard, TouchableOpacity, ActivityIndicator, FlatList } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import VideoCard from "@/components/VideoCard";
import VideoLoadingAnimation from "@/components/VideoLoadingAnimation";
import { api, SearchResult } from "@/services/api";
import { Search, QrCode } from "lucide-react-native";
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

// 缓存管理类
class SearchCacheManager {
  private cache: Map<string, SearchCache> = new Map();
  private maxCacheItems = 10;
  private cacheTimeout = 5 * 60 * 1000; // 5分钟缓存

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

  // 页面大小配置
  const pageSize = 20;

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
  }, []);

  // useEffect(() => {
  //   // Focus the text input when the screen loads
  //   const timer = setTimeout(() => {
  //     textInputRef.current?.focus();
  //   }, 200);
  //   return () => clearTimeout(timer);
  // }, []);

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

  // 搜索实现
  const performSearch = async (searchText?: string, pageNum: number = 1) => {
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
    }
    
    Keyboard.dismiss();
    
    // 检查是否是新搜索或加载更多
    if (pageNum === 1) {
      setLoading(true);
      // 检查缓存 - 只传递有效的非空字符串
      const cached = cacheManager.get(normalizedTerm);
      if (cached) {
        logger.debug("Using cached search results for:", normalizedTerm);
        // 对缓存结果进行排序
        const sortedResults = sortSearchResults([...cached.results], normalizedTerm);
        setResults(sortedResults);
        setTotalResults(cached.total);
        setHasMore(cached.total > sortedResults.length);
        setLoading(false);
        setIsNewSearch(false);
        return;
      }
    } else {
      setLoadingMore(true);
    }
    
    setError(null);
    
    try {
      // 移除重复的超时控制，直接使用api.searchVideos内部的超时机制
      const response = await api.searchVideos(normalizedTerm, undefined, 8000, pageNum, pageSize); // 增加超时时间到8秒
      
      if (response.results.length > 0) {
        // 对搜索结果进行排序
        const sortedResults = sortSearchResults([...response.results], normalizedTerm);
        
        if (pageNum === 1) {
          // 首次搜索，保存到缓存 - 只传递有效的非空字符串
          cacheManager.set(normalizedTerm, sortedResults, response.total);
          setResults(sortedResults);
        } else {
          // 加载更多，追加到现有结果
          setResults(prev => [...prev, ...sortedResults]);
        }
        
        setTotalResults(response.total);
        setHasMore(results.length + sortedResults.length < response.total);
        setCurrentPage(pageNum);
      } else if (pageNum === 1) {
        setError("没有找到相关内容");
      }
    } catch (err) {
      const errorMessage = err instanceof Error && err.name === 'AbortError' 
        ? "搜索超时，请稍后重试。"
        : "搜索失败，请稍后重试。";
      setError(errorMessage);
      logger.info("Search failed:", err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setIsNewSearch(false);
    }
  };
  
  // 搜索结果排序函数
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
      
      // 5. 默认按原始顺序
      return 0;
    });
  }, []);

  // 创建防抖版本的搜索函数
  const debouncedSearch = useCallback(debounce(() => {
    if (keyword.trim()) {
      resetSearchState();
      performSearch(keyword, 1);
    }
  }, 500), [keyword, resetSearchState]);
  
  // 处理搜索
  const handleSearch = (searchText?: string) => {
    const term = searchText || keyword;
    if (term.trim()) {
      resetSearchState();
      performSearch(term, 1);
    }
  };

  const onSearchPress = () => handleSearch();
  
  // 加载更多
  const loadMore = () => {
    if (!loadingMore && hasMore && !loading) {
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

  const renderItem = ({ item, index }: { item: SearchResult; index: number }) => (
    <VideoCard
      id={item.id.toString()}
      source={item.source}
      title={item.title}
      poster={item.poster}
      year={item.year}
      sourceName={item.source_name}
      api={api}
      // 添加图片懒加载支持
      lazyLoad={index > 10} // 前10个立即加载，后面的懒加载
      imageWidth={deviceType === 'tv' ? 200 : deviceType === 'tablet' ? 160 : 120}
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
          />
        </TouchableOpacity>
        <StyledButton style={dynamicStyles.searchButton} onPress={onSearchPress as any}>
            <Search size={deviceType === 'mobile' ? 20 : 24} color="white" />
          </StyledButton>
        {deviceType !== 'mobile' && (
            <StyledButton style={dynamicStyles.qrButton} onPress={handleQrPress as any}>
              <QrCode size={deviceType === 'tv' ? 24 : 20} color="white" />
            </StyledButton>
          )}
      </View>

      {loading && isNewSearch ? (
        <VideoLoadingAnimation showProgressBar={false} />
      ) : error ? (
        <View style={[commonStyles.center, { flex: 1 }]}>
          <ThemedText style={dynamicStyles.errorText}>{error}</ThemedText>
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
          onEndReachedThreshold={0.3}
          ListFooterComponent={renderFooter}
          ListEmptyComponent={
            !loading ? (
              <ThemedText style={dynamicStyles.emptyText}>输入关键词开始搜索</ThemedText>
            ) : null
          }
          // 使用window大小优化渲染性能
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews={true}
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
      errorText: {
        color: "red",
        fontSize: isMobile ? 16 : 18,
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
