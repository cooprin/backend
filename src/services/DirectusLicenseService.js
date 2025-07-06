const axios = require('axios');

class DirectusLicenseService {
    constructor() {
        this.directusUrl = process.env.DIRECTUS_URL || 'https://admin.cooprin.com.ua';
        this.apiUrl = `${this.directusUrl}/items`;
        this.cache = new Map();
        this.cacheTimeout = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Get system license by domain
     */
    async getSystemLicense(domain) {
        try {
            // Check cache
            const cacheKey = `license_${domain}`;
            const cached = this.cache.get(cacheKey);
            
            if (cached && (Date.now() - cached.timestamp) < this.cacheTimeout) {
                return cached.data;
            }

            // Request to Directus
            const response = await axios.get(`${this.apiUrl}/system_licenses`, {
                params: {
                    'filter[domain][_eq]': domain,
                    'filter[status][_eq]': 'active',
                    limit: 1
                },
                timeout: 10000
            });

            if (!response.data || !response.data.data || response.data.data.length === 0) {
                throw new Error(`License for domain ${domain} not found or inactive`);
            }

            const license = response.data.data[0];

            // Check expiration
            if (license.expires_at && new Date(license.expires_at) < new Date()) {
                throw new Error(`License for domain ${domain} expired on ${new Date(license.expires_at).toLocaleDateString()}`);
            }

            // Cache result
            this.cache.set(cacheKey, {
                data: license,
                timestamp: Date.now()
            });

            return license;

        } catch (error) {
            console.error('Error fetching license from Directus:', error.message);
            
            // Fallback - use last cached result if available
            const cacheKey = `license_${domain}`;
            const cached = this.cache.get(cacheKey);
            
            if (cached) {
                console.warn(`Using cached license for ${domain} due to API error`);
                return cached.data;
            }

            throw new Error(`Failed to get license: ${error.message}`);
        }
    }

    /**
     * Log license usage
     */
    async logLicenseUsage(domain, currentObjects, objectLimit, action) {
        try {
            await axios.post(`${this.apiUrl}/license_usage_logs`, {
                system_domain: domain,
                current_objects: currentObjects,
                object_limit: objectLimit,
                action: action,
                checked_at: new Date().toISOString()
            }, {
                timeout: 5000
            });
        } catch (error) {
            console.error('Error logging license usage:', error.message);
            // Don't block system operation if logging fails
        }
    }

    /**
     * Check object limit
     */
    async checkObjectLimit(domain, currentObjectsCount) {
        try {
            const license = await this.getSystemLicense(domain);
            const objectLimit = license.object_limit;
            const remainingObjects = objectLimit - currentObjectsCount;

            // Log check
            await this.logLicenseUsage(domain, currentObjectsCount, objectLimit, 'check_limit');

            const result = {
                allowed: true,
                license,
                currentObjects: currentObjectsCount,
                objectLimit,
                remainingObjects,
                warningLevel: 'none'
            };

            // Limit check logic
            if (remainingObjects <= 0) {
                // Limit reached - block
                result.allowed = false;
                result.warningLevel = 'blocked';
                
                await this.logLicenseUsage(domain, currentObjectsCount, objectLimit, 'creation_blocked');
                
            } else if (remainingObjects <= 10) {
                // 10 or less remaining - warning
                result.warningLevel = 'critical';
                
                await this.logLicenseUsage(domain, currentObjectsCount, objectLimit, 'limit_warning');
            }

            return result;

        } catch (error) {
            console.error('Error checking object limit:', error.message);
            
            // On error, allow creation with logging
            return {
                allowed: true,
                error: error.message,
                currentObjects: currentObjectsCount,
                objectLimit: null,
                remainingObjects: null,
                warningLevel: 'error'
            };
        }
    }

    /**
     * Get license usage statistics
     */
    async getLicenseStats(domain) {
        try {
            const license = await this.getSystemLicense(domain);
            
            // Get logs for last week
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            
            const logsResponse = await axios.get(`${this.apiUrl}/license_usage_logs`, {
                params: {
                    'filter[system_domain][_eq]': domain,
                    'filter[checked_at][_gte]': weekAgo.toISOString(),
                    sort: '-checked_at',
                    limit: 100
                },
                timeout: 10000
            });

            return {
                license,
                recentLogs: logsResponse.data?.data || [],
                stats: {
                    totalChecks: logsResponse.data?.data?.length || 0,
                    lastCheck: logsResponse.data?.data?.[0]?.checked_at || null
                }
            };

        } catch (error) {
            console.error('Error fetching license stats:', error.message);
            throw error;
        }
    }

    /**
     * Clear cache
     */
    clearCache(domain = null) {
        if (domain) {
            this.cache.delete(`license_${domain}`);
        } else {
            this.cache.clear();
        }
    }
}

module.exports = new DirectusLicenseService();