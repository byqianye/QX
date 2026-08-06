package com.qx.spike.host;

import java.util.List;
import java.util.Map;

public interface Spider {
    void init(String ext) throws Exception;

    String homeContent(boolean filter) throws Exception;

    default String categoryContent(
            String typeId,
            int page,
            boolean filter,
            Map<String, String> extend) throws Exception {
        throw new UnsupportedOperationException("categoryContent is not implemented");
    }

    default String detailContent(List<String> ids) throws Exception {
        throw new UnsupportedOperationException("detailContent is not implemented");
    }

    default String searchContent(String key, boolean quick, int page) throws Exception {
        throw new UnsupportedOperationException("searchContent is not implemented");
    }

    default String playerContent(String flag, String id, List<String> vipFlags) throws Exception {
        throw new UnsupportedOperationException("playerContent is not implemented");
    }

    void destroy() throws Exception;
}
