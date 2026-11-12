"""Offline diagnostics preserve capability enforcement while explaining local grants."""
import os
os.environ['DATABASE_URL']='sqlite+aiosqlite:///:memory:'
import unittest
from app.services import execution_capabilities as caps

class CapabilityGuidanceTests(unittest.TestCase):
    def report(self):
        return {'available':['browser','office'], 'items':[
            {'key':'computer','installed':True,'authorized':False,'available':False,
             'detail':'已检测到，等待本机授权'},
            {'key':'files','installed':False,'authorized':True,'available':False,
             'detail':'工作目录不存在'}]}

    def test_reported_case_names_the_local_authorization_step(self):
        verdict=caps.evaluate(self.report(),['browser','computer','office'])
        self.assertFalse(verdict['ok'])
        self.assertEqual(verdict['missing'],['computer'])
        message=caps.error_message(verdict,'DESKTOP-0PS5081')
        self.assertIn('DESKTOP-0PS5081的操作电脑已检测到',message)
        self.assertIn('目标电脑的 SoduWork',message)
        self.assertIn('企业插件审核不会自动授予本机权限',message)
        self.assertNotIn('缺少操作电脑',message)
        self.assertNotIn('computer',verdict['available'])

    def test_mixed_failures_keep_installation_and_authorization_details(self):
        verdict=caps.evaluate(self.report(),['files','computer'])
        message=caps.error_message(verdict,'目标机器')
        self.assertFalse(verdict['ok'])
        self.assertIn('工作目录不存在',message)
        self.assertIn('授权操作电脑',message)

    def test_absent_tool_is_not_described_as_awaiting_a_grant(self):
        verdict=caps.evaluate({'available':[],'items':[
            {'key':'computer','installed':False,'authorized':False,'available':False,
             'detail':'桌面操作脚本不完整'}]},['computer'])
        message=caps.error_message(verdict)
        self.assertIn('桌面操作脚本不完整',message)
        self.assertNotIn('已检测到',message)
        self.assertNotIn('授权操作电脑',message)

    def test_authorization_changes_readiness_only_when_the_report_confirms_it(self):
        report=self.report();report['items'][0].update(authorized=True,available=True)
        verdict=caps.evaluate(report,['browser','computer','office'])
        self.assertTrue(verdict['ok'])
        self.assertEqual(caps.error_message(verdict),'')

if __name__=='__main__':
    unittest.main()
