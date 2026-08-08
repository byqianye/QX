package com.qx.yingshi.androidhost;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class SpiderClassResolverTest {
    @Test
    public void mapsApiInsteadOfSiteKey() {
        assertEquals("com.github.catvod.spider.Duopan", SpiderClassResolver.expectedClass("csp_Duopan"));
        assertTrue(SpiderClassResolver.isExpectedClass("csp_Duopan", "com.github.catvod.spider.Duopan"));
        assertFalse(SpiderClassResolver.isExpectedClass("csp_Duopan", "com.github.catvod.spider.FeiMaoUC"));
    }

    @Test
    public void rejectsInvalidClassSuffixes() {
        assertEquals("", SpiderClassResolver.expectedClass("csp_"));
        assertEquals("", SpiderClassResolver.expectedClass("csp_bad-name"));
    }
}
