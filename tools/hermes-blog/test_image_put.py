import base64
import copy
import hashlib
import socket
import unittest
from unittest.mock import MagicMock, patch
import image_put


class ImagePut(unittest.TestCase):
    def fixture(self):
        body=b'original-image-bytes'
        return {'version':1,'url':'https://'+image_put.HOST+'/articles/owned-image','headers':{'Signature':'grant','authorization':'grant','x-cos-security-token':'temporary','x-cos-meta-fileid':'id','key':'articles%2Fowned-image'},'bodyBase64':base64.b64encode(body).decode(),'byteSize':len(body),'checksumSha256':hashlib.sha256(body).hexdigest(),'timeoutMs':60000}

    def test_raw_bytes_and_exact_headers_are_sent_without_redirects(self):
        value=self.fixture();connection=MagicMock();response=connection.getresponse.return_value;response.status=200;response.getheader.return_value='0';response.read.return_value=b''
        result=image_put.upload(value,connection_factory=lambda host,timeout:connection)
        self.assertEqual(result['status'],200);self.assertEqual(result['networkProfile'],'linux-bbr-v1')
        args=connection.request.call_args;self.assertEqual(args.args,('PUT','/articles/owned-image'));self.assertEqual(args.kwargs['headers'],value['headers']);self.assertEqual(args.kwargs['body'],b'original-image-bytes');connection.close.assert_called_once()

    def test_rejects_other_hosts_malformed_bytes_and_unbounded_input_before_network(self):
        for change in [{'url':'http://'+image_put.HOST+'/'},{'url':'https://another-app.cos.ap-shanghai.myqcloud.com/'},{'url':'https://'+image_put.HOST+':443/'},{'bodyBase64':'bad***'},{'byteSize':True},{'byteSize':image_put.MAX_IMAGE+1},{'checksumSha256':'0'*64},{'timeoutMs':120000}]:
            with self.subTest(change=list(change)):
                value={**self.fixture(),**change};network=MagicMock()
                with self.assertRaises((ValueError,TypeError)):image_put.upload(value,network)
                network.assert_not_called()
        value=self.fixture();value['headers']['authorization']='another signature'
        with self.assertRaises(ValueError):image_put.prepare(value)

    def test_redirect_error_body_and_missing_confirmation_are_not_success(self):
        for status,body in [(302,b''),(503,b'error'),(200,b'unexpected')]:
            connection=MagicMock();response=connection.getresponse.return_value;response.status=status;response.read.return_value=body;response.getheader.return_value=str(len(body))
            with self.assertRaises(ValueError):image_put.upload(self.fixture(),lambda host,timeout:connection)
            connection.close.assert_called_once()

    def test_bbr_is_selected_on_only_the_new_socket(self):
        raw=MagicMock();raw.getsockopt.return_value=b'bbr\0';tls=MagicMock()
        with patch.object(image_put.sys,'platform','linux'),patch.object(image_put.socket,'TCP_CONGESTION',13,create=True),patch.object(image_put.socket,'getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('192.0.2.1',443))]),patch.object(image_put.socket,'socket',return_value=raw):
            conn=image_put.BbrConnection(image_put.HOST,timeout=10);conn._context=MagicMock();conn._context.wrap_socket.return_value=tls;conn.connect()
            raw.setsockopt.assert_called_once_with(socket.IPPROTO_TCP,13,b'bbr');self.assertIs(conn.sock,tls)

    def test_missing_network_profile_fails_without_silent_system_changes(self):
        raw=MagicMock();raw.setsockopt.side_effect=OSError(2,'unavailable')
        with patch.object(image_put.sys,'platform','linux'),patch.object(image_put.socket,'TCP_CONGESTION',13,create=True),patch.object(image_put.socket,'getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('192.0.2.1',443))]),patch.object(image_put.socket,'socket',return_value=raw):
            conn=image_put.BbrConnection(image_put.HOST,timeout=10)
            with self.assertRaises(image_put.NetworkProfileUnavailable):conn.connect()
            raw.connect.assert_not_called();raw.close.assert_called_once()

if __name__=='__main__':unittest.main()
