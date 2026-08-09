package com.github.catvod.crawler;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;

import java.util.HashMap;
import java.util.List;

import org.junit.Test;

public final class SpiderContractTest {
    private static final class EmptySpider extends Spider {
    }

    @Test
    public void defaultContractMatchesCatVodSpiderShape() throws Exception {
        Spider spider = new EmptySpider();

        assertEquals("", spider.homeContent(false));
        assertEquals("", spider.searchContent("keyword", false));
        assertEquals("", spider.searchContent("keyword", false, "1"));
        assertEquals("", spider.categoryContent("1", "1", false, new HashMap<>()));
        assertEquals("", spider.detailContent(List.of("id")));
        assertEquals("", spider.playerContent("flag", "id", List.of()));
        assertFalse(spider.manualVideoCheck());
        assertFalse(spider.isVideoFormat("url"));
        assertNull(spider.proxy(null));
        assertNull(spider.action("action"));
    }
}
