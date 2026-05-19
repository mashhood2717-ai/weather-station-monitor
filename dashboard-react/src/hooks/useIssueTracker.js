import { useState, useCallback } from 'react';
import axios from 'axios';
import { API_BASE } from '../utils/constants';

export function useIssueTracker() {
    const [issues, setIssues] = useState([]);
    const [callStats, setCallStats] = useState(null);
    const [loading, setLoading] = useState(false);

    const fetchIssues = useCallback(async (status = '') => {
        try {
            const params = status ? `?status=${status}` : '';
            const resp = await axios.get(`${API_BASE}/api/issues${params}`);
            setIssues(resp.data || []);
            return resp.data || [];
        } catch (e) {
            console.error('Failed to load issues:', e);
            return [];
        }
    }, []);

    const fetchCallStats = useCallback(async (range = '7d') => {
        try {
            const resp = await axios.get(`${API_BASE}/api/call-stats?range=${range}`);
            setCallStats(resp.data || null);
            return resp.data;
        } catch (e) {
            console.error('Failed to load call stats:', e);
            return null;
        }
    }, []);

    const createIssue = useCallback(async (body) => {
        const resp = await axios.post(`${API_BASE}/api/issues`, body);
        return resp.data;
    }, []);

    const updateIssue = useCallback(async (issueId, body) => {
        const resp = await axios.patch(`${API_BASE}/api/issues/${issueId}`, body);
        return resp.data;
    }, []);

    const deleteIssue = useCallback(async (issueId) => {
        const resp = await axios.delete(`${API_BASE}/api/issues/${issueId}`);
        return resp.data;
    }, []);

    const fetchCalls = useCallback(async (issueId) => {
        const resp = await axios.get(`${API_BASE}/api/issues/${issueId}/calls`);
        return resp.data || [];
    }, []);

    const logCall = useCallback(async (issueId, body) => {
        const resp = await axios.post(`${API_BASE}/api/issues/${issueId}/calls`, body);
        return resp.data;
    }, []);

    const exportCalls = useCallback((range = 'all', caller = '') => {
        const params = new URLSearchParams({ range });
        if (caller) params.set('caller', caller);
        const url = `${API_BASE}/api/export/calls?${params}`;
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }, []);

    const loadAll = useCallback(async (statusFilter = '', range = '7d') => {
        setLoading(true);
        await Promise.all([fetchIssues(statusFilter), fetchCallStats(range)]);
        setLoading(false);
    }, [fetchIssues, fetchCallStats]);

    return {
        issues,
        callStats,
        loading,
        fetchIssues,
        fetchCallStats,
        createIssue,
        updateIssue,
        deleteIssue,
        fetchCalls,
        logCall,
        loadAll,
        exportCalls,
    };
}
