import React, { useState, useEffect } from "react";
import { View, StyleSheet, ActivityIndicator, TouchableOpacity } from "react-native";
import { ThemedText } from "../ThemedText";
import { ThemedView } from "../ThemedView";
import { api, UserInfo } from "../../services/api";
import { useThemeColor } from "../../hooks/useThemeColor";
import { useResponsiveLayout } from "../../hooks/useResponsiveLayout";
import { getCommonResponsiveStyles } from "../../utils/ResponsiveStyles";

interface UserInfoSectionProps {
  onFocus?: () => void;
}

// 默认用户信息，用于防止白屏
const DEFAULT_USER_INFO: UserInfo = {
  username: "未知用户",
  role: "访客",
  groupName: "默认组",
  expiryTime: undefined,
  isExpired: false
};

export function UserInfoSection({ onFocus }: UserInfoSectionProps) {
  // 角色与用户组的一一对应关系映射
  const roleToGroupMapping: Record<string, string> = {
    'admin': '管理员组',
    'vip': 'VIP用户组',
    'premium': '高级会员组',
    'user': '普通用户组',
    'guest': '访客组',
    'trial': '试用用户组'
  };
  
  // 根据角色自动映射用户组
  const mapRoleToGroup = (role?: string): string => {
    if (!role) return "默认组";
    return roleToGroupMapping[role.toLowerCase()] || "默认组";
  };
  
  const [userInfo, setUserInfo] = useState<UserInfo>(DEFAULT_USER_INFO);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const textColor = useThemeColor({}, "text");
  const mutedTextColor = useThemeColor({}, "icon"); // 使用icon颜色作为替代
  const backgroundColor = useThemeColor({}, "background");
  const borderColor = useThemeColor({}, "border");
  
  const responsiveLayout = useResponsiveLayout();
  const responsiveStyles = getCommonResponsiveStyles(responsiveLayout);
  
  // 角色名中文映射
  const roleMapping: Record<string, string> = {
    'admin': '管理员',
    'vip': 'VIP用户',
    'user': '普通用户',
    'guest': '访客',
    'premium': '高级会员',
    'trial': '试用用户'
  };
  
  // 获取中文角色名 - 添加安全检查
  const getChineseRoleName = (role?: string): string => {
    if (!role) return "未知角色";
    // 检查是否已经是中文角色名（如果包含中文字符，则直接返回）
    if (/[\u4e00-\u9fa5]/.test(role)) {
      return role;
    }
    return roleMapping[role.toLowerCase()] || role;
  };

  useEffect(() => {
    // 确保在组件挂载时调用focus回调
    if (onFocus) {
      onFocus();
    }
    
    fetchUserInfo();
  }, [onFocus]);

  const fetchUserInfo = async () => {
    try {
      setIsLoading(true);
      setError(null);
      
      // 增加超时保护
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('请求超时')), 10000)
      );
      
      // 使用Promise.race避免请求超时
      const info = await Promise.race([api.getUserInfo(), timeoutPromise]);
      
      // 确保info是有效的UserInfo对象
      if (info && typeof info === 'object' && info.username) {
        // 创建新的用户信息对象，根据角色自动映射用户组
        const updatedInfo: UserInfo = {
          ...info,
          // 使用角色映射到对应的用户组，建立一一对应关系
          groupName: mapRoleToGroup(info.role)
        };
        setUserInfo(updatedInfo);
      } else {
        throw new Error('无效的用户信息数据');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "获取用户信息失败";
      setError(errorMessage);
      console.error("Failed to fetch user info:", err);
      // 保留默认用户信息，避免白屏
    } finally {
      setIsLoading(false);
    }
  };

  const formatExpiryTime = (timestamp?: number | null) => {
    try {
      if (!timestamp) return "永久";
      
      const date = new Date(timestamp);
      // 检查日期是否有效
      if (isNaN(date.getTime())) return "无效日期";
      
      const now = new Date();
      const isExpired = date < now;
      
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      
      return `${year}-${month}-${day} ${hours}:${minutes}${isExpired ? ' (已过期)' : ''}`;
    } catch (err) {
      console.error("Error formatting expiry time:", err);
      return "永久";
    }
  };

  return (
    <ThemedView style={[styles.container, responsiveStyles.card, { backgroundColor, borderColor }]}>
      <ThemedText style={[styles.sectionTitle, responsiveStyles.sectionTitle]}>
        用户信息
      </ThemedText>
      
      {isLoading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={textColor} />
          <ThemedText style={[styles.loadingText, { color: mutedTextColor }]}>
            加载中...
          </ThemedText>
        </View>
      ) : (
        <View style={styles.infoContainer}>
          {/* 显示错误信息但不隐藏用户信息 */}
          {error && (
            <View style={styles.errorContainer}>
              <ThemedText style={[styles.errorText, responsiveStyles.textMedium]}>
                {error}
              </ThemedText>
              <TouchableOpacity 
                style={[styles.retryButton, { borderColor }]}
                onPress={fetchUserInfo}
                activeOpacity={0.7}
              >
                <ThemedText style={[styles.retryButtonText, { color: textColor }]}>
                  重试
                </ThemedText>
              </TouchableOpacity>
            </View>
          )}
          
          {/* 始终显示用户信息，即使出错也使用默认值 */}
          <View style={styles.infoRow}>
            <ThemedText style={[styles.infoLabel, responsiveStyles.textMedium, { color: mutedTextColor }]}>
              用户名：
            </ThemedText>
            <ThemedText style={[styles.infoValue, responsiveStyles.textLarge]}>
              {userInfo?.username || "未知用户"}
            </ThemedText>
          </View>
          
          <View style={styles.infoRow}>
            <ThemedText style={[styles.infoLabel, responsiveStyles.textMedium, { color: mutedTextColor }]}>
              角色：
            </ThemedText>
            <ThemedText style={[styles.infoValue, responsiveStyles.textLarge]}>
              {getChineseRoleName(userInfo?.role)}
            </ThemedText>
          </View>
          
          <View style={styles.infoRow}>
            <ThemedText style={[styles.infoLabel, responsiveStyles.textMedium, { color: mutedTextColor }]}>
              用户组：
            </ThemedText>
            <ThemedText style={[styles.infoValue, responsiveStyles.textLarge]}>
              {userInfo?.groupName || mapRoleToGroup(userInfo?.role) || "默认组"}
            </ThemedText>
          </View>
          
          <View style={styles.infoRow}>
            <ThemedText style={[styles.infoLabel, responsiveStyles.textMedium, { color: mutedTextColor }]}>
              到期时间：
            </ThemedText>
            <ThemedText style={[
              styles.infoValue, 
              responsiveStyles.textLarge, 
              (userInfo?.isExpired ?? false) && styles.expiredText
            ]}>
              {formatExpiryTime(userInfo?.expiryTime)}
            </ThemedText>
          </View>
        </View>
      )}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  sectionTitle: {
    fontWeight: "bold",
    marginBottom: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  centerContainer: {
    alignItems: "center",
    justifyContent: "center",
    padding: 30,
    minHeight: 200,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
  },
  errorContainer: {
    backgroundColor: "rgba(255, 59, 48, 0.1)",
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255, 59, 48, 0.3)",
    alignItems: "center",
    marginBottom: 16,
  },
  errorText: {
    color: "#ff3b30",
    textAlign: "center",
    marginBottom: 12,
  },
  infoContainer: {
    gap: 16,
  },
  infoRow: {
    flexDirection: "row",
    paddingVertical: 8,
    alignItems: "center",
  },
  infoLabel: {
    fontWeight: "600",
    marginRight: 12,
    flex: 1,
    textAlign: "right",
  },
  infoValue: {
    fontWeight: "500",
    flex: 2,
    textAlign: "left",
    paddingLeft: 8,
  },
  expiredText: {
    color: "#ff3b30",
    fontWeight: "600",
  },
  retryButton: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 120,
  },
  retryButtonText: {
    fontWeight: '600',
    fontSize: 16,
  },
});